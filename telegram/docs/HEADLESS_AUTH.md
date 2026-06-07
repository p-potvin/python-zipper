# Headless Google Drive OAuth2 Authorization

When browser is inaccessible, follow these steps:

## What Happens

When you run the pipeline and browser can't open:

```text
[HEADLESS MODE] Browser unavailable
[STEP 1] Copy this URL and open in browser:

https://accounts.google.com/o/oauth2/auth?response_type=code&client_id=...&scope=...

[STEP 2] After signing in, copy the authorization code
Enter authorization code: _
```

## Authorization Steps

### Step 1: Get the Authorization URL

When pipeline runs, copy the long URL that starts with:

```text
https://accounts.google.com/o/oauth2/auth?...
```

### Step 2: Open in Browser (Any Device)

You can use:

- ✅ Another Windows computer
- ✅ Mac/Linux
- ✅ Smartphone/tablet
- ✅ Any device with internet

Paste the URL into browser address bar.

### Step 3: Sign In to Google

1. Click the URL (or paste in browser)
2. You'll see "Google Sign-In"
3. Sign in with YOUR Google account
4. Click "Allow" to grant access

### Step 4: Copy Authorization Code

After signing in, you are redirected. The URL will look like:

```text
http://localhost:8000/?code=4/0AY0e-123abc...xyz&state=...
```

Look for the `code=` parameter:

- **From:** `http://localhost:8000/?code=4/0AY0e-123abc...xyz&state=...`
- **Copy:** `4/0AY0e-123abc...xyz` (everything after `code=` until `&`)

### Step 5: Paste Code into Pipeline

Pipeline waits for the code:

```text
Enter authorization code: [paste here]
```

Paste the code from Step 4, press Enter.

### Step 6: Done

Token saved automatically. All future runs work without re-authorization.

## Example

**URL shown by pipeline:**

```text
https://accounts.google.com/o/oauth2/auth?response_type=code&client_id=1075698612797-qlq3empsu...
```

**After signing in, redirected to:**

```text
http://localhost:8000/?code=4/0AY0e-qlq73BmEHtF3NQx-H4zKfXi-YT0&state=nzMTTRHQ7XWD
```

**Authorization code to copy:**

```text
4/0AY0e-qlq73BmEHtF3NQx-H4zKfXi-YT0
```

**Paste into pipeline:**

```text
Enter authorization code: 4/0AY0e-qlq73BmEHtF3NQx-H4zKfXi-YT0
```

## Troubleshooting

- **"Code is invalid"**

- Make sure you copy the ENTIRE code (from `code=` to `&`)
- Don't include spaces
- Try again (each code only works once)

- **"Browser can't connect to localhost:8000"**

- That's expected
- Just copy the code from the URL
- Paste into pipeline

- **"Already authorized?"**

- Check if `.gdrive_token.json` exists in `telegram/`
- If yes, previous token is still valid
- No re-authorization needed

- **"Token expired"**

- Delete `telegram/.gdrive_token.json`
- Run pipeline again
- Follow authorization steps once more

## How Often?

**First run:** Requires authorization (Step 1-5 above)

**All subsequent runs:**

- Token cached automatically
- No browser needed
- Works for ~1 year

**Re-authorization needed when:**

- Token expires (older than 1 year)
- You delete `.gdrive_token.json`
- You change Google account permissions

## Security

- ✅ No passwords stored
- ✅ Token only enables Drive uploads
- ✅ No access to other files/settings
- ✅ Stored locally in `telegram/.gdrive_token.json`
- ✅ Can revoke anytime in Google Account settings

## Still Having Issues?

Run the test:

```powershell
cd C:\Users\Administrator\Desktop\Github Repos\python-scripts
.\.venv\Scripts\python.exe telegram\test_headless_oauth.py
```

This verifies headless mode is ready and shows what to expect.
