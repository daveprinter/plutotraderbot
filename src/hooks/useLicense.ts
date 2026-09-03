import { useCallback, useEffect, useRef, useState } from "react";
import { activateLicense, licenseHeartbeat, type LicenseCheck } from "@/lib/license.functions";
import { getDeviceHash, getDeviceName } from "@/lib/device";

const KEY = "pluto:license-code";

export type LicenseState = {
  ready: boolean;
  licensed: boolean;
  code: string;
  info: LicenseCheck["license"] | null;
  error: string | null;
  busy: boolean;
};

export function useLicense() {
  const [state, setState] = useState<LicenseState>({
    ready: false,
    licensed: false,
    code: "",
    info: null,
    error: null,
    busy: false,
  });
  const deviceRef = useRef<string>("");

  const check = useCallback(async (code: string, activate: boolean) => {
    if (!deviceRef.current) deviceRef.current = await getDeviceHash();
    const payload = { code, deviceHash: deviceRef.current, deviceName: getDeviceName() };
    const fn = activate ? activateLicense : licenseHeartbeat;
    return (await fn({ data: payload })) as LicenseCheck;
  }, []);

  // Hydrate on mount
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const saved = (localStorage.getItem(KEY) ?? "").trim();
      if (!saved) {
        setState((s) => ({ ...s, ready: true }));
        return;
      }
      try {
        const res = await check(saved, true);
        if (cancelled) return;
        setState({
          ready: true,
          licensed: res.ok,
          code: saved,
          info: res.license ?? null,
          error: res.ok ? null : (res.message ?? "License check failed"),
          busy: false,
        });
        if (!res.ok && res.reason !== "device_mismatch") localStorage.removeItem(KEY);
      } catch {
        if (!cancelled) setState((s) => ({ ...s, ready: true, error: "Could not reach the licence server." }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [check]);

  // Live presence heartbeat
  useEffect(() => {
    if (!state.licensed || !state.code) return;
    const beat = async () => {
      try {
        const res = await check(state.code, false);
        if (!res.ok) {
          setState((s) => ({ ...s, licensed: false, error: res.message ?? "License is no longer valid." }));
        }
      } catch {
        /* offline — keep working */
      }
    };
    const id = setInterval(beat, 45_000);
    return () => clearInterval(id);
  }, [state.licensed, state.code, check]);

  const activate = useCallback(
    async (raw: string) => {
      const code = raw.trim().toUpperCase();
      if (!code) return;
      setState((s) => ({ ...s, busy: true, error: null }));
      try {
        const res = await check(code, true);
        if (res.ok) localStorage.setItem(KEY, code);
        setState({
          ready: true,
          licensed: res.ok,
          code,
          info: res.license ?? null,
          error: res.ok ? null : (res.message ?? "Activation failed"),
          busy: false,
        });
      } catch (e) {
        setState((s) => ({
          ...s,
          busy: false,
          error: e instanceof Error ? e.message : "Activation failed",
        }));
      }
    },
    [check],
  );

  const signOut = useCallback(() => {
    localStorage.removeItem(KEY);
    setState({ ready: true, licensed: false, code: "", info: null, error: null, busy: false });
  }, []);

  return { ...state, activate, signOut };
}
