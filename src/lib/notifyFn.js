// Calls one of the Netlify Functions under netlify/functions/ (invite-employee,
// send-task-notification). Fire-and-forget by design: a notification email
// failing to send must never roll back or block the write that already
// succeeded — this mirrors AppContext.jsx's existing dbRun/reportBlocked
// convention of treating delivery as a best-effort side channel.
//
// No Supabase-SDK equivalent of supabase.functions.invoke() exists for
// Netlify Functions (that helper is Supabase Edge Functions-specific), so
// the caller's access token is attached by hand as a plain Authorization
// header instead.
export async function callNotifyFunction(path, body, accessToken) {
  if (!accessToken) return;
  try {
    await fetch(`/.netlify/functions/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify(body),
    });
  } catch (e) {
    console.error(`${path} notification failed:`, e);
  }
}
