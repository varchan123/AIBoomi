import twilio from "twilio";

let client: ReturnType<typeof twilio> | undefined;

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function getTwilioClient() {
  if (!client) client = twilio(required("TWILIO_ACCOUNT_SID"), required("TWILIO_AUTH_TOKEN"));
  return client;
}

export function assertWhatsAppConfigured() {
  required("TWILIO_ACCOUNT_SID");
  required("TWILIO_AUTH_TOKEN");
  const from = required("TWILIO_WHATSAPP_FROM");
  if (!from.startsWith("whatsapp:+")) throw new Error("TWILIO_WHATSAPP_FROM is invalid");
}

export async function sendWhatsAppMessage(args: { to: string; body: string }) {
  if (!args.to.startsWith("whatsapp:+")) throw new Error("Invalid approved WhatsApp destination");
  const response = await getTwilioClient().messages.create({
    from: required("TWILIO_WHATSAPP_FROM"), to: args.to, body: args.body,
  });
  return { message_sid: response.sid, delivery_status: response.status || "queued", channel: "whatsapp" as const };
}

export function validateTwilioWebhook(args: { signature: string | null; params: Record<string, string>; path: string }) {
  const signature = args.signature;
  if (!signature) return false;
  const baseUrl = required("APP_BASE_URL").replace(/\/$/, "");
  return twilio.validateRequest(required("TWILIO_AUTH_TOKEN"), signature, `${baseUrl}${args.path}`, args.params);
}

export async function downloadTwilioMedia(mediaUrl: string, maxBytes: number) {
  let url = new URL(mediaUrl);
  const credentials = Buffer.from(`${required("TWILIO_ACCOUNT_SID")}:${required("TWILIO_AUTH_TOKEN")}`).toString("base64");
  let response: Response | undefined;
  for (let redirect = 0; redirect <= 2; redirect += 1) {
    const trustedApi = url.protocol === "https:" && url.hostname === "api.twilio.com";
    const trustedCdn = url.protocol === "https:" && url.hostname.endsWith(".twiliocdn.com");
    if (!trustedApi && !trustedCdn) throw new Error("Untrusted Twilio media URL");
    response = await fetch(url, {
      headers: trustedApi ? { Authorization: `Basic ${credentials}` } : {},
      redirect: "manual",
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get("location");
    if (!location || redirect === 2) throw new Error("Invalid Twilio media redirect");
    url = new URL(location, url);
  }
  if (!response) throw new Error("Could not download Twilio media");
  if (!response.ok) throw new Error(`Could not download Twilio media (${response.status})`);
  const declaredSize = Number(response.headers.get("content-length") || 0);
  if (declaredSize > maxBytes) throw new Error("Voice note exceeds the size limit");
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > maxBytes) throw new Error("Voice note exceeds the size limit");
  return { bytes, contentType: response.headers.get("content-type") || "application/octet-stream" };
}
