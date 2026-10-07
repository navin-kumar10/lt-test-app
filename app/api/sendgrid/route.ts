import { NextResponse } from 'next/server';
import sendgrid from '@sendgrid/mail';
import { z } from 'zod';

// Max contact-form submissions per IP per window. Keeps a script from
// flooding the business inbox (and burning SendGrid quota).
const RATE_LIMIT = 5;
const RATE_WINDOW_MS = 60 * 1000;

// In-memory fixed-window counter. Good enough for a single EC2 instance;
// use Redis/Upstash if the app ever runs on more than one instance.
const rateLimitStore = new Map<string, { count: number; resetAt: number }>();

const contactSchema = z.object({
  name: z.string().trim().min(1).max(100),
  email: z.string().trim().email().max(254),
  phone: z.string().trim().min(7).max(20),
  message: z.string().trim().min(1).max(2000),
});

function getClientIp(req: Request): string {
  const forwardedFor = req.headers.get('x-forwarded-for');

  if (forwardedFor) {
    return forwardedFor.split(',')[0].trim();
  }

  return req.headers.get('x-real-ip') || 'unknown';
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const current = rateLimitStore.get(ip);

  if (!current || now >= current.resetAt) {
    rateLimitStore.set(ip, {
      count: 1,
      resetAt: now + RATE_WINDOW_MS,
    });

    return false;
  }

  if (current.count >= RATE_LIMIT) {
    return true;
  }

  current.count += 1;
  rateLimitStore.set(ip, current);

  return false;
}

export async function POST(req: Request) {
  const clientIp = getClientIp(req);

  if (isRateLimited(clientIp)) {
    return NextResponse.json(
      { error: 'Too many requests. Please try again later.' },
      {
        status: 429,
        headers: {
          'Retry-After': '60',
          'Cache-Control': 'no-store',
        },
      },
    );
  }

  try {
    let body: unknown;

    try {
      body = await req.json();
    } catch {
      return NextResponse.json(
        { error: 'Invalid JSON request body' },
        {
          status: 400,
          headers: {
            'Cache-Control': 'no-store',
          },
        },
      );
    }

    const validation = contactSchema.safeParse(body);

    if (!validation.success) {
      return NextResponse.json(
        { error: 'Invalid contact form data' },
        {
          status: 400,
          headers: {
            'Cache-Control': 'no-store',
          },
        },
      );
    }

    const { name, email, phone, message } = validation.data;

    const apiKey = process.env.SENDGRID_API_KEY;
    const toEmail = process.env.SENDGRID_TO_EMAIL;

    if (!apiKey || !toEmail) {
      console.error('SendGrid configuration is incomplete');
      return NextResponse.json(
        { error: 'Email service is temporarily unavailable' },
        {
          status: 503,
          headers: {
            'Cache-Control': 'no-store',
          },
        },
      );
    }

    sendgrid.setApiKey(apiKey);

    // User input is rendered into an HTML email read by the business owner,
    // so escape it: a submitted link/script must arrive as text, not markup.
    const safeName = escapeHtml(name);
    const safeEmail = escapeHtml(email);
    const safePhone = escapeHtml(phone);
    const safeMessage = escapeHtml(message).replace(/\n/g, '<br />');

    const msg = {
      to: toEmail,
      from: toEmail, // Must be a verified sender in SendGrid
      subject: 'New Contact Form Submission',
      text: `Name: ${name}\nEmail: ${email}\nPhone: ${phone}\nMessage: ${message}`,
      html: `
        <html>
          <body style="background: #f6f6f7; padding: 40px 0;">
            <div style="max-width: 480px; margin: 40px auto; background: #fff; border-radius: 18px; box-shadow: 0 2px 8px rgba(0,0,0,0.04); padding: 32px 32px 24px 32px; font-family: Arial, sans-serif;">
              <div style="text-align: center; margin-bottom: 24px;">
                <div style="font-size: 22px; font-weight: bold; letter-spacing: 1px; color: #222;">
                  NILAVAN REALTORS
                </div>
              </div>

              <hr style="border: none; border-top: 1px solid #eee; margin: 24px 0;" />

              <div style="font-size: 16px; color: #222; margin-bottom: 24px;">
                <p style="margin: 0 0 16px 0;">
                  You have a new contact form submission:
                </p>

                <p style="margin: 0 0 8px 0;">
                  <strong>Name:</strong> ${safeName}
                </p>

                <p style="margin: 0 0 8px 0;">
                  <strong>Email:</strong> ${safeEmail}
                </p>

                <p style="margin: 0 0 8px 0;">
                  <strong>Phone:</strong> ${safePhone}
                </p>

                <p style="margin: 0 0 8px 0;">
                  <strong>Message:</strong> ${safeMessage}
                </p>
              </div>
            </div>
          </body>
        </html>
      `,
    };

    await sendgrid.send(msg);

    return NextResponse.json(
      { success: true },
      {
        headers: {
          'Cache-Control': 'no-store',
        },
      },
    );
  } catch (error: unknown) {
    console.error('SendGrid Error:', error);

    if (error && typeof error === 'object' && 'response' in error) {
      const sgError = error as { response?: { body?: unknown } };
      console.error('SendGrid Response Body:', sgError.response?.body);
    }

    return NextResponse.json(
      { error: 'Error sending email' },
      {
        status: 500,
        headers: {
          'Cache-Control': 'no-store',
        },
      },
    );
  }
}
