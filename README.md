# Nudge

**Nudge is an AI-powered receivables workspace for freelancers and small businesses.**

It helps an owner create and send a real PayPal invoice, lets the client discuss payment options with an AI assistant, and keeps every agreed payment plan inside rules set by the owner.

Nudge does not use mock invoices or fake payments. PayPal Sandbox is used by default, so the complete flow can be tested safely with PayPal Sandbox accounts.
<img width="1521" height="712" alt="image" src="https://github.com/user-attachments/assets/d634a488-d570-42a2-ae0e-face34dc3015" />


## What the project does

### Owner dashboard

- Create an invoice by describing the work in normal language.
- Send the invoice through PayPal.
- View total invoiced, collected, outstanding, and invoices needing attention.
- Set payment guardrails: minimum first payment, maximum number of payments, payment window, and maximum discount.
- Review payment requests that fall outside those guardrails.
- Copy a client payment link or send a PayPal reminder.

### Client payment workspace

- View the invoice and current balance.
- Chat with Nudge about paying in full or using installments.
- Accept an approved payment plan.
- Pay an installment through real PayPal Checkout.
- See payment progress update in the conversation.

  <img width="1382" height="726" alt="image" src="https://github.com/user-attachments/assets/c0497165-594e-4222-afca-208c6f7b32d9" />


### Safety and business logic

The AI can suggest a payment plan, but it cannot change the owner's rules or mark an invoice as paid. The deterministic rules engine validates every offer. Requests outside the rules are sent to the owner for approval.

## AI and developer tools used

- **Groq API** - extracts invoice details from natural-language descriptions, writes negotiation replies, creates structured payment-plan proposals, and writes reminders.
- **Groq model** - configured with `LLM_MODEL`; the template uses `openai/gpt-oss-120b`.
- **PayPal Invoicing API v2** - creates, sends, reads, and updates invoices.
- **PayPal Orders API** - creates and captures real installment payments through PayPal Checkout.
- **PayPal webhooks and polling** - keep invoice payment status current.
- **AG Grid Community** - displays the owner invoice portfolio.
- **Express** - serves the dashboard and API.

## Project structure

```text
server.js          Express API and application routes
lib/agent.js       Groq integration and structured AI responses
lib/paypal.js      PayPal OAuth, invoices, orders, and webhooks
lib/rules.js       Deterministic payment-plan rules
lib/store.js       Local JSON persistence
public/owner.*     Owner dashboard
public/pay.*       Client invoice and chat page
data/db.json       Local application state
render.yaml        Render Blueprint configuration
```

## Run locally

Requirements:

- Node.js 20 or newer
- A PayPal Sandbox Business account and app
- A PayPal Sandbox Personal account for testing as the client
- A Groq API key

```bash
npm install
```

Copy the safe environment template:

```bash
copy .env.example .env
```

On macOS/Linux, use `cp .env.example .env` instead.

Open `.env` and set:

```env
PAYPAL_CLIENT_ID=your_paypal_sandbox_client_id
PAYPAL_CLIENT_SECRET=your_paypal_sandbox_client_secret
PAYPAL_BUSINESS_EMAIL=your_sandbox_business_email
PAYPAL_CURRENCY=USD
PAYPAL_BASE=https://api-m.sandbox.paypal.com
GROQ_API_KEY=your_groq_api_key
LLM_MODEL=openai/gpt-oss-120b
OWNER_NAME=Your name
PUBLIC_URL=http://localhost:3000
```

Start the app:

```bash
npm start
```

Open [http://localhost:3000](http://localhost:3000).

The server validates the required PayPal, Groq, and owner configuration at startup. Never commit `.env`; commit only `.env.example`.

## Test the real Sandbox flow

1. Open the owner dashboard.
2. Describe an invoice, for example: `Ravi owes me $400 for logo design`.
3. Enter the email address of the PayPal Sandbox Personal account.
4. Create and send the invoice.
5. Open the client link from the invoice portfolio.
6. Ask for an installment plan and accept it.
7. Click the PayPal payment button and complete checkout with the Sandbox Personal account.

The end-to-end test requires a running server and a client email:

```bash
set TEST_CLIENT_EMAIL=your_sandbox_personal_email
npm test
```

On macOS/Linux:

```bash
TEST_CLIENT_EMAIL=your_sandbox_personal_email npm test
```

## Deploy on Render

### Option A: Blueprint deployment

1. Create a **public GitHub repository** and push this project to it.
2. Make sure `.env` is ignored and is not included in the repository. Add a `LICENSE` file if required by your submission.
3. Sign in to [Render](https://render.com).
4. Choose **New + → Blueprint**.
5. Select the GitHub repository and deploy the Blueprint.
6. Render reads `render.yaml`, installs dependencies with `npm install`, and starts the app with `npm start`.
7. Open the service's **Environment** page and add the values below.
8. Copy the generated Render URL into `PUBLIC_URL`, for example `https://nudge.onrender.com`.
9. Redeploy after saving the environment variables.

### Option B: Create a Web Service manually

Use these settings:

| Setting | Value |
|---|---|
| Runtime | Node |
| Build command | `npm install` |
| Start command | `npm start` |
| Health check path | `/api/config` |

Add these environment variables in Render:

| Variable | Value |
|---|---|
| `PAYPAL_CLIENT_ID` | PayPal Sandbox app client ID |
| `PAYPAL_CLIENT_SECRET` | PayPal Sandbox app secret |
| `PAYPAL_BUSINESS_EMAIL` | PayPal Sandbox Business email |
| `PAYPAL_CURRENCY` | `USD` |
| `PAYPAL_BASE` | `https://api-m.sandbox.paypal.com` |
| `PAYPAL_WEBHOOK_ID` | Optional until a webhook is registered |
| `GROQ_API_KEY` | Groq API key |
| `LLM_MODEL` | `openai/gpt-oss-120b` |
| `OWNER_NAME` | Name shown to clients |
| `PUBLIC_URL` | Full Render URL, including `https://` |

For PayPal webhook updates, register:

```text
https://YOUR-APP.onrender.com/api/webhooks/paypal
```

Then copy the webhook ID into `PAYPAL_WEBHOOK_ID` and redeploy.

## Important deployment notes

- This app uses PayPal Sandbox by default. Do not switch to live PayPal credentials until you are ready for real transactions.
- Render's free service can sleep after inactivity, so the first request may take a little longer.
- Local invoice state is stored in `data/db.json`. A free Render instance may lose local file changes after a redeploy or restart. Use a persistent database before production use.
- Add authentication before exposing the owner dashboard publicly.
- Never publish API keys, PayPal secrets, or `.env` in GitHub.
