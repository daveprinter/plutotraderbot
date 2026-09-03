import { createServerFn } from "@tanstack/react-start";

export type AdminLicenseRow = {
  id: string;
  code: string;
  customer_label: string;
  status: string;
  plan: string;
  max_activations: number;
  expires_at: string | null;
  created_at: string;
  notes: string;
  devices: { id: string; device_hash: string; device_name: string; last_seen_at: string; activated_at: string }[];
  online: boolean;
};

const ONLINE_WINDOW_MS = 90_000;

async function adminClient() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin;
}

async function requireAdmin(token: string) {
  const supabaseAdmin = await adminClient();
  const { data: session } = await supabaseAdmin
    .from("admin_sessions")
    .select("*")
    .eq("token", token)
    .maybeSingle();
  if (!session || !session.verified || new Date(session.expires_at).getTime() < Date.now()) {
    throw new Error("Admin session expired. Please sign in again.");
  }
  return supabaseAdmin;
}

function randomCode(len: number) {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let out = "";
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  for (let i = 0; i < len; i++) out += alphabet[bytes[i]! % alphabet.length];
  return out;
}

const ADMIN_EMAIL_DEFAULT = "vitralparts306@gmail.com";
const CODE_TTL_MS = 5 * 60_000;
const RESEND_COOLDOWN_MS = 30_000;

function sixDigitCode() {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return String(100000 + (buf[0]! % 900000));
}

async function sendVerificationEmail(email: string, code: string): Promise<boolean> {
  const apiKey = process.env["RESEND_API_KEY"];
  if (!email || !apiKey) return false;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "Pluto Trader <onboarding@resend.dev>",
        to: [email],
        subject: `${code} is your Pluto Trader admin code`,
        html: `<div style="font-family:Arial,sans-serif;max-width:420px;margin:auto;padding:24px">
  <h2 style="margin:0 0 12px">Pluto Trader admin login</h2>
  <p>Your verification code is</p>
  <p style="font-size:32px;letter-spacing:8px;font-weight:bold;margin:8px 0 16px">${code}</p>
  <p style="color:#666">This code expires in <strong>5 minutes</strong>. If you did not request it, you can ignore this email.</p>
</div>`,
      }),
    });
    if (!res.ok) console.error(`Resend failed [${res.status}]: ${await res.text()}`);
    return res.ok;
  } catch (e) {
    console.error("Resend request error", e);
    return false;
  }
}

async function adminEmail(supabaseAdmin: Awaited<ReturnType<typeof adminClient>>) {
  const { data } = await supabaseAdmin.from("app_settings").select("value").eq("key", "admin_email").maybeSingle();
  return (data?.value || "").trim() || ADMIN_EMAIL_DEFAULT;
}

function maskEmail(email: string) {
  const [user = "", domain = ""] = email.split("@");
  return `${user.slice(0, 2)}${"*".repeat(Math.max(1, user.length - 2))}@${domain}`;
}

/** Step 1 — admin panel code, then a 6-digit verification code is emailed (valid 5 minutes). */
export const adminStart = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => {
    const v = input as { code?: string };
    return { code: String(v?.code ?? "").trim() };
  })
  .handler(async ({ data }): Promise<{ ok: boolean; token?: string; sentTo?: string | undefined; message: string }> => {
    const supabaseAdmin = await adminClient();
    const { data: settings } = await supabaseAdmin.from("app_settings").select("key, value");
    const map = Object.fromEntries((settings ?? []).map((s) => [s.key, s.value]));

    if (data.code !== (map["admin_code"] || "4050")) {
      return { ok: false, message: "Wrong admin panel code." };
    }

    const token = crypto.randomUUID();
    const verification = sixDigitCode();
    await supabaseAdmin.from("admin_sessions").insert({ token, verification_code: verification });

    const email = (map["admin_email"] || "").trim() || ADMIN_EMAIL_DEFAULT;
    const sent = await sendVerificationEmail(email, verification);
    const sentTo = sent ? maskEmail(email) : undefined;

    return {
      ok: true,
      token,
      sentTo,
      message: sentTo
        ? `A 6-digit code was sent to ${sentTo}. It expires in 5 minutes.`
        : "Could not send the verification email — use the testing verification code or try resending.",
    };
  });

/** Resend a fresh 6-digit code for an existing (unverified) admin session. */
export const adminResendCode = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => ({ token: String((input as { token?: string })?.token ?? "") }))
  .handler(async ({ data }): Promise<{ ok: boolean; message: string; retryInMs?: number }> => {
    const supabaseAdmin = await adminClient();
    const { data: session } = await supabaseAdmin
      .from("admin_sessions")
      .select("*")
      .eq("token", data.token)
      .maybeSingle();
    if (!session) return { ok: false, message: "Session not found. Start again." };
    if (session.verified) return { ok: false, message: "This session is already verified." };
    if (new Date(session.expires_at).getTime() < Date.now())
      return { ok: false, message: "Session expired. Start again." };

    const sinceLast = Date.now() - new Date(session.created_at).getTime();
    if (sinceLast < RESEND_COOLDOWN_MS) {
      const retryInMs = RESEND_COOLDOWN_MS - sinceLast;
      return { ok: false, retryInMs, message: `Please wait ${Math.ceil(retryInMs / 1000)}s before resending.` };
    }

    const verification = sixDigitCode();
    await supabaseAdmin
      .from("admin_sessions")
      .update({ verification_code: verification, created_at: new Date().toISOString() })
      .eq("id", session.id);

    const email = await adminEmail(supabaseAdmin);
    const sent = await sendVerificationEmail(email, verification);
    return sent
      ? { ok: true, message: `A new code was sent to ${maskEmail(email)}. It expires in 5 minutes.` }
      : { ok: false, message: "Could not send the verification email. Try again shortly." };
  });

/** Step 2 — email verification code (must be used within 5 minutes of being sent). */
export const adminVerify = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => {
    const v = input as { token?: string; code?: string };
    return { token: String(v?.token ?? ""), code: String(v?.code ?? "").trim() };
  })
  .handler(async ({ data }): Promise<{ ok: boolean; message: string; expired?: boolean }> => {
    const supabaseAdmin = await adminClient();
    const { data: session } = await supabaseAdmin
      .from("admin_sessions")
      .select("*")
      .eq("token", data.token)
      .maybeSingle();
    if (!session) return { ok: false, message: "Session not found. Start again." };
    if (new Date(session.expires_at).getTime() < Date.now())
      return { ok: false, message: "Session expired. Start again." };

    // Testing fallback code (configurable via the fallback_verification_code setting).
    const { data: fallbackRow } = await supabaseAdmin
      .from("app_settings")
      .select("value")
      .eq("key", "fallback_verification_code")
      .maybeSingle();
    const fallback: string | null = fallbackRow?.value?.trim() || null;

    const usedFallback = fallback !== null && data.code === fallback;
    if (!usedFallback) {
      if (Date.now() - new Date(session.created_at).getTime() > CODE_TTL_MS) {
        return { ok: false, expired: true, message: "This code has expired. Request a new one." };
      }
      if (data.code !== session.verification_code) {
        return { ok: false, message: "Wrong verification code." };
      }
    }
    await supabaseAdmin.from("admin_sessions").update({ verified: true }).eq("id", session.id);
    return { ok: true, message: "Welcome to the admin panel." };
  });

export const adminListLicenses = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => ({ token: String((input as { token?: string })?.token ?? "") }))
  .handler(async ({ data }): Promise<AdminLicenseRow[]> => {
    const supabaseAdmin = await requireAdmin(data.token);
    const { data: licenses } = await supabaseAdmin
      .from("licenses")
      .select("*")
      .order("created_at", { ascending: true });
    const { data: devices } = await supabaseAdmin.from("license_devices").select("*");

    const now = Date.now();
    return (licenses ?? []).map((l) => {
      const own = (devices ?? []).filter((d) => d.license_id === l.id);
      return {
        ...l,
        devices: own.map((d) => ({
          id: d.id,
          device_hash: d.device_hash,
          device_name: d.device_name,
          last_seen_at: d.last_seen_at,
          activated_at: d.activated_at,
        })),
        online: own.some((d) => now - new Date(d.last_seen_at).getTime() < ONLINE_WINDOW_MS),
      } as AdminLicenseRow;
    });
  });

export const adminGenerateLicense = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => {
    const v = input as { token?: string; customer?: string; plan?: string; days?: number };
    return {
      token: String(v?.token ?? ""),
      customer: String(v?.customer ?? "").trim(),
      plan: String(v?.plan ?? "monthly"),
      days: Number(v?.days ?? 30),
    };
  })
  .handler(async ({ data }) => {
    const supabaseAdmin = await requireAdmin(data.token);
    const { count } = await supabaseAdmin.from("licenses").select("id", { count: "exact", head: true });
    const label = data.customer || `CUSTOMER ${String((count ?? 0) + 1).padStart(3, "0")}`;
    const code = `PLUTO-${randomCode(4)}-${randomCode(4)}-${randomCode(4)}`;
    const expires =
      data.plan === "lifetime" || data.days <= 0
        ? null
        : new Date(Date.now() + data.days * 86_400_000).toISOString();

    const { data: created, error } = await supabaseAdmin
      .from("licenses")
      .insert({ code, customer_label: label, plan: data.plan, expires_at: expires })
      .select()
      .single();
    if (error) throw new Error(error.message);

    await supabaseAdmin.from("license_events").insert({
      license_id: created.id,
      license_code: code,
      event: "generated",
      detail: `${label} · ${data.plan}`,
    });
    return created;
  });

export const adminLicenseAction = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => {
    const v = input as { token?: string; licenseId?: string; action?: string; days?: number };
    return {
      token: String(v?.token ?? ""),
      licenseId: String(v?.licenseId ?? ""),
      action: String(v?.action ?? ""),
      days: Number(v?.days ?? 30),
    };
  })
  .handler(async ({ data }): Promise<{ ok: boolean; message: string }> => {
    const supabaseAdmin = await requireAdmin(data.token);
    const { data: license } = await supabaseAdmin
      .from("licenses")
      .select("*")
      .eq("id", data.licenseId)
      .maybeSingle();
    if (!license) return { ok: false, message: "License not found." };

    const setStatus = async (status: string, message: string) => {
      await supabaseAdmin.from("licenses").update({ status }).eq("id", license.id);
      return message;
    };

    let message: string;
    switch (data.action) {
      case "activate":
        message = await setStatus("active", "License activated.");
        break;
      case "deactivate":
        message = await setStatus("inactive", "License deactivated.");
        break;
      case "suspend":
        message = await setStatus("suspended", "License suspended.");
        break;
      case "unsuspend":
        message = await setStatus("active", "License un-suspended.");
        break;
      case "revoke":
        message = await setStatus("revoked", "License revoked.");
        break;
      case "reset_device":
        await supabaseAdmin.from("license_devices").delete().eq("license_id", license.id);
        message = "Device binding reset — the customer can activate on a device again.";
        break;
      case "extend": {
        const base =
          license.expires_at && new Date(license.expires_at).getTime() > Date.now()
            ? new Date(license.expires_at).getTime()
            : Date.now();
        await supabaseAdmin
          .from("licenses")
          .update({ expires_at: new Date(base + data.days * 86_400_000).toISOString() })
          .eq("id", license.id);
        message = `Expiry extended by ${data.days} days.`;
        break;
      }
      case "delete":
        await supabaseAdmin.from("licenses").delete().eq("id", license.id);
        message = "License deleted.";
        break;
      default:
        return { ok: false, message: "Unknown action." };
    }

    if (data.action !== "delete") {
      await supabaseAdmin.from("license_events").insert({
        license_id: license.id,
        license_code: license.code,
        event: data.action,
        detail: message,
      });
    }

    // Push the change to any device currently running this license so it
    // reacts instantly instead of waiting for the next heartbeat.
    try {
      await supabaseAdmin.channel(`license:${license.code}`).send({
        type: "broadcast",
        event: "status",
        payload: { action: data.action },
      });
    } catch (e) {
      console.error("License broadcast failed", e);
    }
    return { ok: true, message };
  });

export const adminLicenseHistory = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => {
    const v = input as { token?: string; licenseId?: string };
    return { token: String(v?.token ?? ""), licenseId: String(v?.licenseId ?? "") };
  })
  .handler(async ({ data }) => {
    const supabaseAdmin = await requireAdmin(data.token);
    const { data: events } = await supabaseAdmin
      .from("license_events")
      .select("*")
      .eq("license_id", data.licenseId)
      .order("created_at", { ascending: false })
      .limit(100);
    return events ?? [];
  });

export const adminGetEmail = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => ({ token: String((input as { token?: string })?.token ?? "") }))
  .handler(async ({ data }) => {
    const supabaseAdmin = await requireAdmin(data.token);
    const { data: row } = await supabaseAdmin
      .from("app_settings")
      .select("value")
      .eq("key", "admin_email")
      .maybeSingle();
    return { email: row?.value ?? "" };
  });

export const adminSetEmail = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => {
    const v = input as { token?: string; email?: string };
    return { token: String(v?.token ?? ""), email: String(v?.email ?? "").trim() };
  })
  .handler(async ({ data }) => {
    const supabaseAdmin = await requireAdmin(data.token);
    await supabaseAdmin
      .from("app_settings")
      .upsert({ key: "admin_email", value: data.email, updated_at: new Date().toISOString() });
    return { ok: true };
  });
