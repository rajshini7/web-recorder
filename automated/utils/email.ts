import nodemailer from "nodemailer";

/* ================= EMAIL ================= */

export async function sendFailureEmail(subject: string, html: string) {
  const transporter = nodemailer.createTransport({
    host: process.env.EMAIL_HOST,
    port: Number(process.env.EMAIL_PORT || 587),
    secure: false,
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS,
    },
  });

  await transporter.sendMail({
    from: `"Replay Bot" <${process.env.EMAIL_USER}>`,
    to: process.env.ALERT_TO,
    subject,
    html,
  });
}

export function buildMinimalFailureEmail(data: {
  step: number;
  url: string;
  recordedFirstP: string;
  liveFirstP: string;
  reason?: string;
}) {
  return `
    <h2 style="color:red;">❌ Web Replay Failed</h2>

    <p><strong>Step:</strong> ${data.step}</p>
    <p><strong>URL:</strong> ${data.url}</p>

    ${data.reason ? `<p><strong>Reason:</strong> ${data.reason}</p>` : ""}

    <hr/>

    <p><strong>Recorded firstP:</strong></p>
    <pre>${data.recordedFirstP}</pre>

    <p><strong>Replayed firstP:</strong></p>
    <pre>${data.liveFirstP}</pre>
  `;
}
