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
const ADMIN_CODE_DEFAULT = "0000";
const CODE_TTL_MS = 5 * 60_000;
const RESEND_COOLDOWN_MS = 30_000;

export type EmailDelivery = "resend" | "lovable" | "both";

type EmailConfig = {
  adminEmail: string;
  adminCode: string;
  fallbackCode: string | null;
  resendKey: string | null;
  /** The email address that owns the Resend account (Resend only delivers there until a domain is verified). */
  resendOwnerEmail: string;
  delivery: EmailDelivery;
};

function sixDigitCode() {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return String(100000 + (buf[0]! % 900000));
}

async function loadConfig(supabaseAdmin: Awaited<ReturnType<typeof adminClient>>): Promise<EmailConfig> {
  const { data: settings } = await supabaseAdmin.from("app_settings").select("key, value");
  const map = Object.fromEntries((settings ?? []).map((s) => [s.key, (s.value ?? "").trim()]));
  const delivery = (["resend", "lovable", "both"].includes(map["email_delivery"] ?? "")
    ? map["email_delivery"]
    : "resend") as EmailDelivery;
  return {
    adminEmail: map["admin_email"] || ADMIN_EMAIL_DEFAULT,
    adminCode: map["admin_code"] || ADMIN_CODE_DEFAULT,
    fallbackCode: map["fallback_verification_code"] || null,
    resendKey: map["resend_api_key"] || process.env["RESEND_API_KEY"] || null,
    resendOwnerEmail: map["resend_owner_email"] || ADMIN_EMAIL_DEFAULT,
    delivery,
  };
}

function codeHtml(code: string) {
  return `<div style="font-family:Arial,sans-serif;max-width:420px;margin:auto;padding:24px">
  <h2 style="margin:0 0 12px">Pluto Trader admin login</h2>
  <p>Your verification code is</p>
  <p style="font-size:32px;letter-spacing:8px;font-weight:bold;margin:8px 0 16px">${code}</p>
  <p style="color:#666">This code expires in <strong>5 minutes</strong>. If you did not request it, you can ignore this email.</p>
</div>`;
}

async function sendViaResend(apiKey: string | null, email: string, code: string): Promise<boolean> {
  if (!email || !apiKey) return false;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "Pluto Trader <onboarding@resend.dev>",
        to: [email],
        subject: `${code} is your Pluto Trader admin code`,
        html: codeHtml(code),
      }),
    });
    if (!res.ok) console.error(`Resend failed [${res.status}]: ${await res.text()}`);
    return res.ok;
  } catch (e) {
    console.error("Resend request error", e);
    return false;
  }
}

/**
 * Lovable Emails delivery. Becomes active once an email domain is set up for
 * this project and the app email templates are scaffolded; until then it
 * reports "not sent" so the caller can fall back gracefully.
 */
async function sendViaLovable(email: string, _code: string): Promise<boolean> {
  if (!email) return false;
  console.warn("Lovable Emails is not configured for this project yet — verification code not sent via Lovable.");
  return false;
}

/** Sends the code according to the configured delivery mode. Returns the masked recipients that were reached. */
async function sendVerificationEmail(cfg: EmailConfig, code: string): Promise<string[]> {
  const reached: string[] = [];
  const tryResend = async (to: string) => (await sendViaResend(cfg.resendKey, to, code)) && reached.push(maskEmail(to));
  const tryLovable = async (to: string) => (await sendViaLovable(to, code)) && reached.push(maskEmail(to));

  if (cfg.delivery === "resend") await tryResend(cfg.adminEmail);
  else if (cfg.delivery === "lovable") await tryLovable(cfg.adminEmail);
  else {
    // both: original Resend-owner email via Resend + the admin email via Lovable
    await tryResend(cfg.resendOwnerEmail);
    if (cfg.adminEmail.toLowerCase() !== cfg.resendOwnerEmail.toLowerCase()) await tryLovable(cfg.adminEmail);
  }
  return [...new Set(reached)];
}

function maskEmail(email: string) {
  const [user = "", domain = ""] = email.split("@");
  return `${user.slice(0, 2)}${"*".repeat(Math.max(1, user.length - 2))}@${domain}`;
}

function sentMessage(reached: string[]) {
  return reached.length
    ? `A 6-digit code was sent to ${reached.join(" and ")}. It expires in 5 minutes.`
    : "Could not send the verification email — check the email settings in the admin panel, use the testing verification code, or try resending.";
}

/** Step 1 — admin panel code, then a 6-digit verification code is emailed (valid 5 minutes). */
export const adminStart = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => {
    const v = input as { code?: string };
    return { code: String(v?.code ?? "").trim() };
  })
  .handler(async ({ data }): Promise<{ ok: boolean; token?: string; sentTo?: string | undefined; message: string }> => {
    const supabaseAdmin = await adminClient();
    const cfg = await loadConfig(supabaseAdmin);

    if (data.code !== cfg.adminCode) {
      return { ok: false, message: "Wrong admin panel code." };
    }

    const token = crypto.randomUUID();
    const verification = sixDigitCode();
    await supabaseAdmin.from("admin_sessions").insert({ token, verification_code: verification });

    const reached = await sendVerificationEmail(cfg, verification);
    return { ok: true, token, sentTo: reached.length ? reached.join(" and ") : undefined, message: sentMessage(reached) };
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

    const reached = await sendVerificationEmail(await loadConfig(supabaseAdmin), verification);
    return reached.length
      ? { ok: true, message: `A new code was sent to ${reached.join(" and ")}. It expires in 5 minutes.` }
      : { ok: false, message: "Could not send the verification email. Check email settings or try again shortly." };
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

export type AdminSettings = {
  adminEmail: string;
  adminCode: string;
  fallbackCode: string;
  delivery: EmailDelivery;
  resendOwnerEmail: string;
  /** Masked preview of the active Resend key (never the full key). */
  resendKeyPreview: string | null;
  lovableEmailReady: boolean;
};

function maskKey(key: string | null) {
  if (!key) return null;
  return `${key.slice(0, 6)}${"•".repeat(8)}${key.slice(-4)}`;
}

export const adminGetSettings = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => ({ token: String((input as { token?: string })?.token ?? "") }))
  .handler(async ({ data }): Promise<AdminSettings> => {
    const supabaseAdmin = await requireAdmin(data.token);
    const cfg = await loadConfig(supabaseAdmin);
    return {
      adminEmail: cfg.adminEmail,
      adminCode: cfg.adminCode,
      fallbackCode: cfg.fallbackCode ?? "",
      delivery: cfg.delivery,
      resendOwnerEmail: cfg.resendOwnerEmail,
      resendKeyPreview: maskKey(cfg.resendKey),
      lovableEmailReady: false,
    };
  });

/** Checks a Resend key is accepted by Resend (401/403 = invalid). */
async function verifyResendKey(key: string): Promise<{ ok: boolean; message?: string }> {
  try {
    const res = await fetch("https://api.resend.com/domains", {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (res.status === 401 || res.status === 403) return { ok: false, message: "Resend rejected this API key." };
    return { ok: true };
  } catch {
    return { ok: false, message: "Could not reach Resend to validate the key." };
  }
}

export const adminUpdateSettings = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => {
    const v = input as {
      token?: string;
      adminEmail?: string;
      adminCode?: string;
      fallbackCode?: string;
      delivery?: string;
      resendApiKey?: string;
      resendOwnerEmail?: string;
    };
    const delivery = ["resend", "lovable", "both"].includes(String(v?.delivery)) ? (v!.delivery as EmailDelivery) : "resend";
    return {
      token: String(v?.token ?? ""),
      adminEmail: String(v?.adminEmail ?? "").trim().toLowerCase(),
      adminCode: String(v?.adminCode ?? "").trim(),
      fallbackCode: String(v?.fallbackCode ?? "").trim(),
      delivery,
      resendApiKey: String(v?.resendApiKey ?? "").trim(),
      resendOwnerEmail: String(v?.resendOwnerEmail ?? "").trim().toLowerCase(),
    };
  })
  .handler(async ({ data }): Promise<{ ok: boolean; message: string }> => {
    const supabaseAdmin = await requireAdmin(data.token);

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.adminEmail)) return { ok: false, message: "Enter a valid admin email." };
    if (!/^\d{4,8}$/.test(data.adminCode)) return { ok: false, message: "Admin panel code must be 4–8 digits." };
    if (data.fallbackCode && !/^\d{4,8}$/.test(data.fallbackCode))
      return { ok: false, message: "Testing verification code must be 4–8 digits (or empty to disable)." };
    if (data.resendApiKey && !data.resendApiKey.startsWith("re_"))
      return { ok: false, message: "Resend API keys start with re_." };

    if (data.resendApiKey) {
      const check = await verifyResendKey(data.resendApiKey);
      if (!check.ok) return { ok: false, message: check.message ?? "Invalid Resend key." };
    }

    const now = new Date().toISOString();
    const rows: { key: string; value: string; updated_at: string }[] = [
      { key: "admin_email", value: data.adminEmail, updated_at: now },
      { key: "admin_code", value: data.adminCode, updated_at: now },
      { key: "fallback_verification_code", value: data.fallbackCode, updated_at: now },
      { key: "email_delivery", value: data.delivery, updated_at: now },
    ];
    if (data.resendApiKey) {
      rows.push({ key: "resend_api_key", value: data.resendApiKey, updated_at: now });
      // A fresh key belongs to the account of the (new) admin email unless told otherwise.
      rows.push({ key: "resend_owner_email", value: data.resendOwnerEmail || data.adminEmail, updated_at: now });
    } else if (data.resendOwnerEmail) {
      rows.push({ key: "resend_owner_email", value: data.resendOwnerEmail, updated_at: now });
    }

    const { error } = await supabaseAdmin.from("app_settings").upsert(rows, { onConflict: "key" });
    if (error) return { ok: false, message: error.message };
    return { ok: true, message: "Admin settings updated. They apply to the next login." };
  });
