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

/** Step 1 — admin panel code, then a verification code is emailed. */
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
    const verification = String(Math.floor(100000 + Math.random() * 900000));
    await supabaseAdmin.from("admin_sessions").insert({ token, verification_code: verification });

    const email = (map["admin_email"] || "").trim();
    const apiKey = process.env["RESEND_API_KEY"];
    let sentTo: string | undefined;

    if (email && apiKey) {
      try {
        const res = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            from: "Pluto Trader <onboarding@resend.dev>",
            to: [email],
            subject: "Pluto Trader admin verification code",
            html: `<p>Your admin verification code is <strong style="font-size:20px">${verification}</strong>. It expires in 12 hours.</p>`,
          }),
        });
        if (res.ok) sentTo = email;
      } catch {
        /* fall back to the demo code */
      }
    }

    return {
      ok: true,
      token,
      sentTo,
      message: sentTo
        ? `Verification code sent to ${sentTo}.`
        : "Email is not configured yet — use the demo verification code 0000.",
    };
  });

/** Step 2 — email verification code (demo fallback: 0000). */
export const adminVerify = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => {
    const v = input as { token?: string; code?: string };
    return { token: String(v?.token ?? ""), code: String(v?.code ?? "").trim() };
  })
  .handler(async ({ data }): Promise<{ ok: boolean; message: string }> => {
    const supabaseAdmin = await adminClient();
    const { data: session } = await supabaseAdmin
      .from("admin_sessions")
      .select("*")
      .eq("token", data.token)
      .maybeSingle();
    if (!session) return { ok: false, message: "Session not found. Start again." };
    if (new Date(session.expires_at).getTime() < Date.now())
      return { ok: false, message: "Session expired. Start again." };

    const { data: fallbackRow } = await supabaseAdmin
      .from("app_settings")
      .select("value")
      .eq("key", "fallback_verification_code")
      .maybeSingle();
    const fallback = fallbackRow?.value || "0000";

    if (data.code !== session.verification_code && data.code !== fallback) {
      return { ok: false, message: "Wrong verification code." };
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
