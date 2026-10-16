# Connecting Tally Prime to Kinematic — Setup Guide

**Time needed:** about 15 minutes.
**Who does what**
- **Kinematic admin** — logs in to the Kinematic dashboard (Steps 1, 5, 6, 7).
- **Person at the Tally PC** — has Windows administrator rights on the computer where Tally runs (Steps 2–4).

**Before you start**
- [ ] Tally Prime is installed on a Windows PC, and your company is open in Tally.
- [ ] That PC has internet access and stays switched on during working hours.
- [ ] The Distribution module is enabled for your Kinematic account (you can see **Distribution → Integrations**).
- [ ] You can sign in to the Kinematic dashboard as an admin.

The connector only makes *outgoing* connections to Kinematic. You do **not** need to open any port on your router or firewall.

---

## Step 1 — Create the Tally connection (Kinematic admin, dashboard)

1. Go to **Distribution → Integrations**.
2. Click **+ Add integration** → choose **Tally**.
3. Give it a name (for example *Gomant — Head Office Tally*).
4. Leave the ledger names as they are unless your Tally uses different names. Anything missing in Tally can be created for you in Step 5.
5. The **Tally company name** is optional here — you can pick it later from a list.
6. Click **Connect**.

You now see a **6-character pairing code** (for example `K7F-29X`). It works **once** and expires after **24 hours**. Keep this screen open, or write the code down. You can generate a new code any time.

## Step 2 — Turn on Tally's connection setting (person at the Tally PC)

In Tally Prime:

1. Press **F1 (Help) → Settings → Connectivity → Client/Server configuration**.
2. Set **TallyPrime acts as** to **Both**.
3. Set **Port** to **9000**.
4. Save, and restart Tally if it asks.
5. Open your company in Tally and leave it open.

## Step 3 — Download the Kinematic connector (person at the Tally PC)

1. On the Tally PC, open this link in a browser:
   `https://api.kinematicapp.com/api/v1/integrations/tally/agent/download`
   (or click **download the Kinematic connector** in the dashboard's pairing panel).
2. Save **kinematic-tally-agent.exe** to a folder, for example `C:\Kinematic`.
3. Windows may warn about an *unknown publisher* because the file is new. This is expected:
   - Right-click the file → **Properties** → tick **Unblock** → **OK**, **or**
   - In the SmartScreen warning click **More info → Run anyway**.

## Step 4 — Pair the connector (person at the Tally PC)

1. Click **Start**, type `cmd`, right-click **Command Prompt** → **Run as administrator**.
2. Go to the folder and run the pairing command with **your** code:

   ```
   cd C:\Kinematic
   kinematic-tally-agent.exe pair K7F-29X
   ```

3. You should see messages like:
   - `Paired. Config saved to C:\ProgramData\Kinematic\TallyConnector\config.json`
   - `Installed. "Kinematic Tally Connector" starts automatically with Windows and is running now.`
   - `Tally is reachable. Companies: <your company>`

The connector now starts by itself every time the PC starts. You can close the window.

> If it says *Tally is not reachable*, check Step 2 (Tally open, setting on, port 9000), then run `kinematic-tally-agent.exe check`.

## Step 5 — Check readiness (Kinematic admin, dashboard)

1. In **Distribution → Integrations**, open your Tally card and click **Set up & sync**.
2. The page refreshes every few seconds and shows a checklist:
   - ✅ Connector is running
   - ✅ Tally is reachable
   - ✅ Tally company selected
   - ✅ Required ledgers exist
   - ✅ Voucher types available
3. Fix anything shown with ❌ or ⚠️:
   - **Which Tally company?** — choose your company from the list and click **Save**.
   - **Required ledgers missing** (for example *Sales Account*, *CGST*, *SGST*, *IGST*, *Cash*, *Bank*, *Round Off*, *Sales Returns*) — click **Create missing ledgers in Tally**. They appear in Tally within about 30 seconds and the checklist updates. *Please have your accountant glance at the new ledgers' groups in Tally.*

When every line is green, the connection is ready.

## Step 6 — Bring in your products and dealers from Tally (Kinematic admin)

1. In **Set up & sync**, click **Pull from Tally**. It takes about a minute.
2. You will see counts for **Products** and **Dealers / parties**:
   - **Matched** — already in Kinematic. These were linked automatically by GSTIN (dealers) or by item code / exact name. Nothing was created.
   - **To review** — not found in Kinematic yet.
3. Click **Review & import**.
   - Check the **To review** list for Products and for Dealers (use search to narrow).
   - Tick the ones you want and click **Import selected**, or click **Import all new**.
   - Use **Ignore selected** for anything you do not want in Kinematic (cash ledgers, internal accounts, etc.).
4. Imported items are linked to their Tally record, so invoices use the exact Tally name.

> Nothing is created in Kinematic until you click Import. Re-run **Pull from Tally** whenever you add new products or dealers in Tally.

## Step 7 — Run a test (Kinematic admin + accountant)

1. In Kinematic, raise one **test invoice** for a dealer that is linked to Tally.
2. Within about 30 seconds, check Tally: **Gateway → Display → Day Book**. You should see a **Sales** voucher for that dealer, with GST posted to the CGST/SGST/IGST ledgers.
3. Record a **payment** against it in Kinematic → a **Receipt** voucher appears in Tally, allocated to that invoice.
4. Record a **return** → a **Credit Note** appears.
5. In the dashboard, **View events** shows each sync as *Synced* with its Tally voucher number.

If you are happy, delete or cancel the test vouchers in Tally as per your normal practice.

---

## What the connection does today

| In Kinematic | Appears in Tally as |
|---|---|
| Invoice (issued) | Sales voucher, with GST ledger entries and round-off |
| Payment (cleared) | Receipt voucher, allocated to the invoice |
| Return (credited/approved) | Credit Note |
| — | Products and dealers are **pulled from Tally** into Kinematic (Step 6) |

**Not included yet** (planned next): stock-item quantity lines on invoices, Sales Orders, creating new dealers/products in Tally from Kinematic, and pulling invoices raised in Tally back into Kinematic.

## Day-to-day

- Keep **Tally open** with the company loaded, and the **PC switched on and online** while you work. If the PC is off, nothing is lost — Kinematic queues vouchers and sends them when the connector is back (failed ones are retried automatically).
- The dashboard shows when the connector was last seen and lists any failed syncs with the reason.

## Troubleshooting

| What you see | What to do |
|---|---|
| *Pairing code invalid or expired* | Generate a new code in the dashboard (Set up & sync → Connect / re-connect a Tally PC). |
| *Cannot connect to Tally* | Tally is closed, or the setting from Step 2 is off. Open Tally, check port 9000. |
| Checklist says connector not running | PC off or offline. Turn it on, or in an administrator Command Prompt run: `schtasks /Run /TN "Kinematic Tally Connector"` |
| *Ledger '…' does not exist* | Use **Create missing ledgers** in the checklist, or correct the ledger name in the integration settings (spaces and capitals must match Tally exactly). |
| Wrong company | Open the right company in Tally, then choose it in the checklist. |
| A voucher shows *Failed* | Open **View events** for the reason; fix it (usually a ledger name); it retries automatically. |
| Windows blocks the file | Right-click → Properties → Unblock. |

To remove the connector from a PC: run `kinematic-tally-agent.exe uninstall` as administrator.

## If you need help

Send us:
1. A screenshot of the **Set up & sync** checklist.
2. The file `C:\ProgramData\Kinematic\TallyConnector\agent.log` (it contains no passwords).
3. The output of `kinematic-tally-agent.exe check`.

## Security notes

- The connector only talks to Kinematic and to Tally on the same PC. No data goes anywhere else.
- Its access key is stored in `C:\ProgramData\Kinematic\TallyConnector`, restricted to Windows administrators. Do not email or share that folder.
- If the PC is lost or replaced, remove the integration in the dashboard (or ask us to reset it) and pair the new PC with a new code.
