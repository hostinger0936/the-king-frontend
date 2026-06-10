// src/pages/LoginPage.tsx
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

import { createAdminSession, getAdminLogin, saveAdminLogin } from "../services/api/admin";
import { setLoggedIn, logout } from "../services/api/auth";
import { ENV, STORAGE_KEYS } from "../config/constants";

const DEFAULT_PIN = "1234";

function safeStr(v: any) { return (v ?? "").toString().trim(); }

function getOrCreateWebDeviceId(): string {
  const KEY = "zerotrace_web_device_id";
  try {
    const existing = localStorage.getItem(KEY);
    if (existing?.trim()) return existing.trim();
    const n = Math.max(1, Number(localStorage.getItem("zerotrace_web_device_counter") || "1") || 1);
    const id = `device${n}`;
    localStorage.setItem(KEY, id);
    localStorage.setItem("zerotrace_web_device_counter", String(n + 1));
    return id;
  } catch { return `device${Math.floor(Math.random() * 10000)}`; }
}

// ─── Warning Modal ────────────────────────────────────────────────────────────
function DefaultPinWarning({ onClose }: { onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-[999] flex items-center justify-center bg-black/40 px-4">
      <div className="w-full max-w-[360px] rounded-2xl bg-white p-6 shadow-xl">
        <div className="mb-3 text-[18px] font-extrabold text-amber-600">⚠️ Default Password!</div>
        <div className="text-[14px] leading-6 text-gray-700">
          Ye ek <strong>default password (1234)</strong> hai. Kripya ise turant change karein,
          warna aapka data chori ho sakta hai!
        </div>
        <div className="mt-5 flex gap-3">
          <button type="button" onClick={onClose}
            className="flex-1 rounded-xl border border-gray-200 bg-gray-50 py-2.5 text-[14px] font-semibold text-gray-700 hover:bg-gray-100">
            Baad Mein
          </button>
          <button type="button" onClick={onClose}
            className="flex-1 rounded-xl bg-amber-500 py-2.5 text-[14px] font-extrabold text-white hover:bg-amber-600">
            Change Now
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── LOGIN PAGE ───────────────────────────────────────────────────────────────
export default function LoginPage() {
  const nav = useNavigate();

  // Step: "token" → "pin"
  const [step,        setStep]        = useState<"token" | "pin">("token");
  const [tokenInput,  setTokenInput]  = useState("");
  const [pin,         setPin]         = useState("");
  const [error,       setError]       = useState<string | null>(null);
  const [loading,     setLoading]     = useState(true);
  const [saving,      setSaving]      = useState(false);
  const [limitReached, setLimitReached] = useState(false);
  const [showWarning,  setShowWarning]  = useState(false);

  const [storedUser, setStoredUser] = useState("");
  const [storedPass, setStoredPass] = useState("");

  const pinRef = useRef<HTMLInputElement>(null);

  // Load stored credentials
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const data = await getAdminLogin();
        if (!mounted) return;
        setStoredUser(safeStr(data?.username));
        setStoredPass(safeStr(data?.password));
      } catch {}
      finally { if (mounted) setLoading(false); }
    })();
    return () => { mounted = false; };
  }, []);

  // ── Step 1: Validate Token ─────────────────────────────────────────────────
  function handleProceed(e?: React.FormEvent) {
    if (e) e.preventDefault();
    setError(null);
    const token = tokenInput.trim();
    if (!token) { setError("Token ID required"); return; }

    const expected = safeStr(ENV.PANEL_ID);
    if (!expected) { setError("Panel not configured. Contact developer."); return; }
    if (token !== expected) { setError("Invalid Token ID"); return; }

    setStep("pin");
    setTimeout(() => pinRef.current?.focus(), 100);
  }

  // ── Step 2: Login with PIN ─────────────────────────────────────────────────
  async function handleSignIn(e?: React.FormEvent) {
    if (e) e.preventDefault();
    setError(null);
    setLimitReached(false);

    const p = pin.trim();
    if (!p) { setError("PIN required"); return; }

    // Username = stored or default "admin"
    const username = storedUser || "admin";

    setSaving(true);
    try {
      // If credentials already stored → validate
      if (storedUser && storedPass) {
        if (p !== storedPass) { setError("Invalid PIN"); return; }
      } else {
        // First time → save as admin credentials
        await saveAdminLogin(username, p);
        setStoredUser(username);
        setStoredPass(p);
      }

      // Login success
      setLoggedIn(username);

      try {
        const deviceId = getOrCreateWebDeviceId();
        await createAdminSession(username, deviceId);
      } catch (err: any) {
        const code = safeStr(err?.response?.data?.error);
        if (code === "limit_reached") {
          logout();
          setLimitReached(true);
          return;
        }
      }

      // Show warning if default PIN
      if (p === DEFAULT_PIN) {
        setShowWarning(true);
        // Navigate after warning is dismissed
        return;
      }

      nav("/");
    } catch (err: any) {
      setError(safeStr(err?.response?.data?.error || err?.message || "Login failed"));
    } finally {
      setSaving(false);
    }
  }

  function afterWarningDismiss() {
    setShowWarning(false);
    nav("/");
  }

  // ── Contact Us → WhatsApp ──────────────────────────────────────────────────
  function openWhatsApp() {
    const target = safeStr(ENV.WHATSAPP_TARGET);
    if (!target) return;
    // target can be a number or full URL
    const url = target.startsWith("http") ? target : `https://wa.me/${target.replace(/\D/g, "")}`;
    window.open(url, "_blank", "noopener,noreferrer");
  }

  // ── Telegram Channel ───────────────────────────────────────────────────────
  function openTelegram() {
    const url = safeStr(ENV.TELEGRAM_CHANNEL) || "https://t.me/";
    window.open(url, "_blank", "noopener,noreferrer");
  }

  const version = safeStr(ENV.VERSION) || "v1.0";

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#f0f2f5] px-4">
      {/* Warning Modal */}
      {showWarning && <DefaultPinWarning onClose={afterWarningDismiss} />}

      <div className="w-full max-w-[380px] rounded-2xl bg-white p-7 shadow-[0_4px_24px_rgba(0,0,0,0.10)]">

        {/* Title */}
        <h1 className="mb-6 text-center text-[22px] font-extrabold text-gray-900">
          Welcome Back, Admin
        </h1>

        {loading ? (
          <div className="py-6 text-center text-gray-400 text-[14px]">Loading…</div>
        ) : (

          <>
            {/* ── STEP 1: Token ID ── */}
            {step === "token" && (
              <form onSubmit={handleProceed} className="space-y-4">
                <div>
                  <label className="mb-1.5 block text-[14px] font-semibold text-gray-600">Token ID</label>
                  <input
                    value={tokenInput}
                    onChange={(e) => { setTokenInput(e.target.value); setError(null); }}
                    placeholder="Token ID *"
                    autoFocus
                    className="h-12 w-full rounded-xl border border-gray-200 bg-white px-4 text-[14px] text-gray-900 placeholder-gray-400 outline-none focus:border-gray-400 focus:ring-2 focus:ring-gray-100"
                  />
                </div>

                {error && <div className="rounded-xl bg-red-50 px-3 py-2 text-[13px] text-red-600">{error}</div>}

                <button type="submit"
                  className="rounded-xl border border-gray-800 bg-white px-5 py-2.5 text-[14px] font-extrabold text-gray-900 hover:bg-gray-50 active:scale-[0.98]">
                  Proceed
                </button>
              </form>
            )}

            {/* ── STEP 2: PIN ── */}
            {step === "pin" && (
              <form onSubmit={handleSignIn} className="space-y-4">
                {/* Token shown (read-only) */}
                <div>
                  <label className="mb-1.5 block text-[14px] font-semibold text-gray-600">Token ID</label>
                  <input value={tokenInput} readOnly
                    className="h-12 w-full rounded-xl border border-gray-200 bg-gray-50 px-4 text-[14px] text-gray-500 outline-none cursor-default" />
                </div>

                <div>
                  <label className="mb-1.5 block text-[14px] font-semibold text-gray-600">PIN</label>
                  <input
                    ref={pinRef}
                    value={pin}
                    onChange={(e) => { setPin(e.target.value); setError(null); }}
                    type="password"
                    placeholder="PIN *"
                    inputMode="numeric"
                    className="h-12 w-full rounded-xl border border-gray-200 bg-white px-4 text-[14px] text-gray-900 placeholder-gray-400 outline-none focus:border-gray-400 focus:ring-2 focus:ring-gray-100"
                  />
                </div>

                {/* Limit reached error */}
                {limitReached && (
                  <div className="rounded-xl bg-red-50 px-3 py-2 text-[13px] text-red-600">
                    ⚠️ Maximum 5 devices logged in. Contact developer to increase limit.
                  </div>
                )}

                {error && !limitReached && (
                  <div className="rounded-xl bg-red-50 px-3 py-2 text-[13px] text-red-600">{error}</div>
                )}

                <div className="flex gap-3">
                  <button type="submit" disabled={saving}
                    className="rounded-xl border border-gray-800 bg-white px-5 py-2.5 text-[14px] font-extrabold text-gray-900 hover:bg-gray-50 active:scale-[0.98] disabled:opacity-60">
                    {saving ? "Signing in…" : "Sign In"}
                  </button>
                  <button type="button" onClick={() => { setStep("token"); setPin(""); setError(null); setLimitReached(false); }}
                    className="rounded-xl border border-gray-200 bg-white px-4 py-2.5 text-[14px] font-semibold text-gray-600 hover:bg-gray-50">
                    Back
                  </button>
                </div>
              </form>
            )}

            {/* ── Contact Us + Telegram ── */}
            <div className="mt-5 space-y-3">
              <button type="button" onClick={openWhatsApp}
                className="w-full rounded-xl border-2 border-green-500 bg-white py-3 text-[14px] font-extrabold text-green-600 hover:bg-green-50 active:scale-[0.98]">
                Contact Us
              </button>

              <button type="button" onClick={openTelegram}
                className="w-full rounded-xl border-2 border-blue-500 bg-white py-3 text-[14px] font-extrabold text-blue-600 hover:bg-blue-50 active:scale-[0.98]">
                Telegram Channel
              </button>
            </div>

            {/* Version */}
            <div className="mt-5 text-center text-[13px] font-semibold text-green-600">
              Version: {version}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
