# Archstone Connect

CRM and WhatsApp marketing for Archstone, in one system with separate logins for each role.

## Try it on this computer

1. Double-click **Start Archstone Connect.bat**.
2. Your browser opens at `http://localhost:4000`.
3. Open `data/first-login-passwords.txt` for the temporary passwords. Each account must set a new password at first login.
4. When everyone has signed in, delete that file.

The app starts in **demo mode**: sample leads and units, and WhatsApp messages that are simulated, not sent. Anything simulated is labelled on screen.

## Roles

These are the starting points. An admin can change any of them under **Team → Permissions**, or for one person using **Permissions** beside their name, including which leads they can see.

| Role | Sees | Can do |
| --- | --- | --- |
| Admin | Everything | Everything, always |
| Sales Manager | All leads | Reassign leads, approve bookings, view reports, manage files |
| Site Head | Their own projects | Manage units, approve bookings, run check-ins, manage files |
| Marketing | All leads, phones hidden | Templates, broadcasts, imports, reports, files |
| Sales Person | Their own leads | Work leads, send broadcasts to their leads, hold units |
| Pre-Sales Telecaller | Their own leads | Call, qualify, send broadcasts to their leads, hand off to sales |

Rules are enforced on the server, so changing a link or calling the API directly does not bypass them.

## WhatsApp numbers and inboxes

Open **Monitor → WhatsApp numbers** to add a number and assign it to a person. That person then gets:

- Their own inbox, which colleagues cannot open
- Replies sent from their own number
- New chats on that number assigned to them automatically
- Broadcasts to their own leads, with their own daily limit

An admin can open any inbox, and doing so does not mark it read for the staff member. **Monitor** shows every number and staff action live.

Please note:

- Every number must be registered on the WhatsApp Business Platform. Each one has its own Meta limits and quality rating.
- A number on the Cloud API normally cannot also stay on the regular WhatsApp app, so use dedicated numbers, or check Meta's coexistence option.
- Broadcasts use approved templates and reach only people who gave consent. This protects your numbers from being banned.
- Staff broadcasts need approval until an admin grants "Send broadcasts without approval".

## Calling mode

Open **Calling** on any phone. Staff work one lead at a time, ordered by overdue follow-ups, new leads, then highest score. After each call they must save the result before the next lead opens. Admins can switch that off in **Settings → Rules**.

**New list** cleans an Excel or CSV file by removing repeats and invalid numbers, leaves existing leads with the person assigned to them, and shares the rest equally between the people you choose.

Talk time from phone calls is measured from tapping Call until the result is saved, so it is an estimate. Exotel calls record exact duration.

## Android app

The `mobile` folder is an Android app project called Archstone Connect. It opens your live Archstone Connect system, so every update you make reaches the app with no reinstall. Staff enter your address once, on first launch.

To build it, install [Android Studio](https://developer.android.com/studio), accept its licence, and open `mobile/android`. Move the project to a short path such as `C:\archstone` first, because Android builds can fail on long Windows paths. Choose **Build → Generate App Bundles or APKs**.

For the Play Store, you need a Google Play Developer account and a signing key that you keep safe.

Once built, put the APK in `web/public/archstone-connect-app.apk` so staff can download it from `https://your-crm-address/archstone-connect-app.apk`. Android asks you to allow installs from unknown sources, because it did not come from the Play Store.

### Phone notifications in the app

The app sends alerts through Firebase Cloud Messaging. Both Firebase files are set from the admin panel, so you can replace the Firebase project at any time without rebuilding the app:

1. In the [Firebase console](https://console.firebase.google.com/), open your project and add an Android app with the package name `com.archstone.connect`.
2. **Project settings → Your apps → download `google-services.json`**. In Archstone Connect, go to **Settings → Integrations → Android app notifications** and upload it under **App settings**.
3. **Project settings → Service accounts → Generate new private key**, then upload that file under **Server key**. It is stored encrypted.
4. Open the app on your phone, allow notifications, then choose **Send test to my phone**.

To switch projects later, choose **Replace** on both. Phones move to the new project the next time the app opens. Delete the downloaded key file afterwards and never send it to anyone.

Browser notifications (Chrome, Edge, Firefox, and iPhone home-screen apps) do not need Firebase at all. Staff turn them on in **My Account**.

Exports and downloads inside the app still need testing on a real phone.

## Live hosting

For Hostinger, follow `HOSTINGER.md`. On other hosts, keep everything on a permanent disk. Everything it stores is on the permanent disk mounted at `/data`, including the database, uploads, the encryption key and daily backups.

Automatic daily backups stay on the same disk as the live data, so also keep a copy elsewhere. In **Settings → Integrations**, an administrator can download an encrypted backup, and admins are reminded each week. The passphrase is never stored, so keep it safe. To unpack a backup into an empty folder:

```bash
npm run restore-backup -- archstone-connect-2026-11-07.archstonebackup restored-data
```

It asks for the passphrase and refuses a damaged file. To release an update, run `railway up` from this folder. The server refuses to start in production unless `APP_URL` uses https, `SECURE_COOKIES` is true and `DEMO_MODE` is false.

## Alerts and follow-ups

The **Follow-ups** page lists overdue, due today, upcoming and completed follow-ups, with call, WhatsApp, snooze and done buttons. Staff are told about new leads the moment they are assigned, before each follow-up, and when one is missed. Overdue alerts repeat a set number of times, then go to the manager. Each morning, everyone gets a summary of what is overdue and due today.

Set the timing and quiet hours in **Settings → Alerts**. Each person chooses their own alerts in **My Account**. WhatsApp alerts to staff need a mobile number on their profile, and the `staff_` templates approved by Meta.

## Selling tools

- **Matching homes:** a lead's page lists available homes that fit their budget, size and location. **Matching buyers** on a project shows who to call when stock opens up.
- **Workflow rules:** in **Settings → Workflows**, set rules such as "when a Meta lead arrives, create a call in 5 minutes". Rules can run when a lead arrives, changes stage or goes quiet. WhatsApp rules still follow consent and MahaRERA checks.
- **Buyer page:** on a booking, create a private link where the buyer sees payments and handover progress. Creating a new link stops the old one.
- **Duplicates:** **Leads → Duplicates** finds likely repeats by name or email and merges them. A merge cannot be undone, and later enquiries from the merged number join the kept lead.

## Lead routing

**Lead Routing** decides who gets each lead. A mapping matches a campaign, ad set, ad, form or source, then shares leads between chosen people by turns or by lightest workload. It can also set the project. The first matching mapping wins, and paused people are skipped. Leads with no mapping use the normal routing rule.

The Campaigns tab shows each campaign from the last 30 days, its leads, visits, bookings and who received them, and offers **Map campaign** for anything unmapped.

To connect Meta, add your page ID and page access token under **Meta pages**, set the webhook address in your Meta app, and subscribe the page to `leadgen`. Leads then arrive instantly, and a pull every 15 minutes recovers any that were missed. Instant delivery needs `WHATSAPP_VERIFY_TOKEN` and `META_APP_SECRET` in Railway.

**Meta feedback** tells Meta what became of its leads, using the Conversions API for CRM, so it can look for more real buyers. It stays off until you add your Dataset ID and token and turn it on. Results go every hour, and its Health panel shows Meta's targets: 200 leads a month, 60% coverage, and a 1% to 40% rate for your main quality stage. Use a test event code first, and clear it when you go live. Only stages reached by Meta leads from the last 90 days are sent, and Meta rejects events older than about 7 days.

Meta form answers about home size and budget fill the lead's requirement automatically, so **Matching homes** works from the first minute. Managers can add notes on a lead that agents never see.

## Team structure

In **Team → Structure**, see everyone's reporting line. Edit a person and set **Reports to**.

Until reporting lines are set, access works by role. Once someone has a team, they see their own leads and those of everyone below them, at every level. Admins always see everything. Team Leaders see only their team. Overdue alerts go to the direct manager, then up one level each time the wait passes. Approvals go to the nearest manager who may approve them, and Team Leaders assign leads only within their team.

## Agent performance

The **Performance** page shows each person's follow-ups, calls, site visits, bookings and response time. Filter by period, agent, project, role or team, or choose one person to see their own card. Sales staff and telecallers see only themselves.

A follow-up counts as on time if it is done within 30 minutes of its due time. The activity score is 50% on-time follow-ups, 25% call connect rate and 25% first response speed. Snoozed follow-ups are counted, so moving a follow-up shows up rather than hiding a delay.

## Filters

Every list has filters, and they stay in the page address, so Back, refresh and shared links keep them. Leads also have stage tabs with counts, multi-select task status, budget bands, a budget slider, sort, saved views and exports that match the filters on screen. Choose **Assigned to: Unassigned** on Leads to see **Auto distribute**, which shares those leads out by your routing rule.

## Labels

Set your labels and colours in **Settings → Labels**. Staff tag a chat with one tap in the inbox or on the lead page. You can filter the inbox and Leads by label, and pick labels as the audience for a broadcast.

## Property files

Upload brochures, photos, floor plans and videos under **Property Files**. Staff can send them from the inbox, and they can be used at the top of a template. Files have long private links, because WhatsApp must be able to fetch them, so upload only marketing material here. KYC documents go on the lead page, where they stay encrypted.

## Before going live

### 1. Host it
Every connection below is set up by an administrator in **Settings → Integrations**, using **Set up** or **Edit**. Keys are encrypted in the database, are never shown again, and work without a restart. Each one can also be set as a server variable, which is used until a value is saved in Settings.

Put the app on a server with HTTPS (a small cloud server is enough), so your team can reach it from anywhere and Meta can deliver webhooks. These few must stay on the server, because the app needs them to start:

```
DEMO_MODE=false
SECURE_COOKIES=true
APP_URL=https://your-crm-address
INITIAL_ADMIN_EMAIL=the-admin-email
```

Start with an empty `data` folder so no sample data carries over. Back up the `data` folder every day. It holds your customer data, so keep it private.

### 2. Connect WhatsApp
1. In [Meta Business](https://business.facebook.com), verify the business and add a WhatsApp Business number.
2. In [Meta for Developers](https://developers.facebook.com), create an app and add the WhatsApp product.
3. In **Settings → Integrations**, fill in **WhatsApp Cloud API** (a permanent System User token, phone number ID and business account ID) and **WhatsApp replies webhook** (the Meta app secret, and a verify token you choose or generate).
4. In the app's webhook settings, use `https://your-crm-address/webhooks/whatsapp` with your verify token. Subscribe to `messages` and `message_template_status_update`. For numbers that stay on the WhatsApp Business app too (Meta's coexistence, connected through a Solution Partner or Tech Provider), also subscribe to `smb_message_echoes` and `history`. Then use **Import past chats** within 24 hours of connecting.
5. In Archstone Connect, open **Campaigns → Templates** and submit each template. Meta reviews them.

WhatsApp charges per message by category, and Meta's rules apply. Only message people who agreed to it.

### 3. Connect your website form
Open **Website enquiry form** in Integrations, generate a key and copy it before saving. Have your website send each enquiry from its **server** (never from browser code, which would expose the key):

```
POST https://your-crm-address/webhooks/website
Header: X-Api-Key: your-key
Body: {"name":"...","phone":"...","email":"...","message":"...","project":"Skyline Residences","whatsapp_consent":true}
```

Send `whatsapp_consent: true` only when the person ticked a consent box.

### 4. Connect Meta Lead Ads (optional)
Add your pages in **Lead Routing**, or add a page token under **Meta Lead Ads** in Integrations, then point a `leadgen` webhook at `https://your-crm-address/webhooks/meta-leads`.

### 5. Connect property portals (optional)
99acres, MagicBricks and Housing.com each need your account manager to enable lead delivery. Generate a key under **Property portals** in Integrations. Ask them to send each lead to these addresses, with that key in an `X-Api-Key` header:

```
https://your-crm-address/webhooks/portal/99acres
https://your-crm-address/webhooks/portal/magicbricks
https://your-crm-address/webhooks/portal/housing
```

Common field names such as `name`, `mobile`, `email`, `project_name` and `query` are recognised. If a portal can only email leads, import them by CSV.

### 6. Connect the office phone line (optional)
Create an [Exotel](https://exotel.com) account, then fill in **Exotel click-to-call** in Integrations and generate a call update token. Each staff member needs their mobile number on their Team profile.

Call recording is off by default. If you turn it on in Settings, tell customers that calls are recorded.

### 7. Connect Google (optional)
In [Google Cloud Console](https://console.cloud.google.com), turn on the Calendar, People and Drive APIs and create an OAuth client. Register `https://your-crm-address/api/google/callback` as a redirect URL, and add the client ID and secret in Integrations. Each person then connects their own account from **My Account**.

"Add to calendar" links and "Save contact" downloads work without this set-up.

### 8. Turn on AI (optional)
Add a key from [Google AI Studio](https://aistudio.google.com) under **Gemini AI** in Integrations. Staff get lead summaries and reply drafts in English, Hindi and Marathi. A person reviews each draft before sending.

### 9. Set up email and the rest (optional)
Fill in **Email (SMTP)** to send reports and urgent alerts by email, and **Google Ads lead forms** for Google Ads leads. Under **WhatsApp Cloud API**, add your WhatsApp number for hoarding QR codes and the Meta app ID for templates with media. In your WhatsApp webhook, also subscribe to `phone_number_quality_update`. Files sent on WhatsApp need `APP_URL` to be your public HTTPS address.

### 10. Check your details
- Add each project's **MahaRERA number**. Project marketing stays blocked until you do.
- Confirm Skyline Residences's location and price. The website shows two of each.
- Add each project's GST, stamp duty, registration and other charges. Cost sheets leave out anything blank.
- Set your default payment plan in **Settings → Rules**.
- Replace the sample units with real inventory.

## Keep these safe

The app copies the database to `data/backups` every day and keeps two weeks. That copy sits on the same machine, so also copy the whole `data` folder somewhere else every day, including `data/secret.key`, `data/documents` and `data/media`. The key decrypts KYC documents, two-factor secrets, WhatsApp tokens and Google connections. If it is lost, they cannot be recovered. Keep the backup private, because it contains customer data.

## Security on a live system

- With `DEMO_MODE=false`, every admin must set up two-factor login before using the app. Other staff can turn it on from **My Account**.
- If someone loses their phone, they can use a recovery code, or an admin can reset two-factor login from **Team**.
- Phone notifications and offline mode need HTTPS.
- Offline mode keeps a recent copy of leads in the browser. It is cleared when someone signs out, so staff should always sign out of shared devices.

## For developers

Stack: TypeScript, React, Tailwind, Express and SQLite (Node's built-in `node:sqlite`, which is still marked experimental). All database access is in `server/`, so moving to PostgreSQL later is contained.

```bash
npm install
npm run dev        # web on :5173, API on :4000
npm test           # API, permission and compliance tests
npm run build      # type-check and build the web app
npm start          # serve the built app on :4000
```

Live WhatsApp, Meta, Exotel, Google and Gemini calls were not run against the real services during development, because no credentials were available. Tests check the requests we send and the replies we handle using a fake server. Portal field names are common spellings, not confirmed against each portal's specification. Run a real test of each connection before launch.
