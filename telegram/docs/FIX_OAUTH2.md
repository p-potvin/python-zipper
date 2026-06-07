# Fixing OAuth2 redirect_uri_mismatch Error

## The Problem

When you try to authorize with Google Drive, you get:

```text
Error 400: redirect_uri_mismatch
```

This means the redirect_uri the code is using doesn't match what's registered in your Google Cloud Console.

## Solution: Register localhost Redirect URIs

### Step 1: Open Google Cloud Console

Go to: <https://console.cloud.google.com/>

### Step 2: Select your project

- Make sure you're in the correct project (the one with the Google Drive OAuth credentials)

### Step 3: Go to OAuth Credentials

Navigate to:

- **APIs & Services** → **Credentials**
- Find your **OAuth 2.0 Client ID** (Desktop application)
- Click on it to edit

### Step 4: Add Redirect URIs

In the "Authorized redirect URIs" section, add these URIs:

```text
http://localhost:8080
http://localhost:8888
http://localhost:5000
```

### Step 5: Save Changes

Click **Save** button

### Step 6: Download Updated Credentials

You may need to download the credentials file again:

1. Go to **Credentials** page
2. Click the download icon (⬇️) next to your OAuth 2.0 Client ID
3. Save as `client_secret_*.json` in `C:\Users\Administrator\Desktop\Github Repos\.access\`

## Alternative: Quick Test

If you don't want to reconfigure Google Cloud Console, you can:

### Option A: Use out-of-band flow (recommended)

1. The script will show you a Google authorization URL
2. Copy it to your browser and sign in
3. Copy the authorization code from the URL
4. Paste it back into the script

### Option B: Temporarily accept invalid redirect_uri

This is usually not recommended, but if the URL is already registered in a different format, you can:

1. Check what redirect_uri is actually registered
2. Update the client_secrets.json file format if needed

## Testing the Fix

After updating Google Cloud Console:

```powershell
# This will trigger re-authorization
del telegram\.gdrive_token.json

# Now run again
python telegram/process_unrestricted_links.py
```

The script will:

1. Try port 8080 (should work now if registered)
2. Try port 8888 as fallback
3. Fall back to manual browser entry if needed

## What You'll See

**Success:**

```text
[OAUTH2] ✓ Authorization successful
[OK] Google Drive authenticated via OAuth2
```

**Fallback (if localhost doesn't work):**

```text
[OAUTH2] Copy and visit this URL in your browser: https://accounts.google.com/o/oauth2/auth?...
[OAUTH2] You will be redirected to localhost (even if it fails)
[OAUTH2] Copy the authorization code from the URL
Enter the authorization code: <paste code here>
```

## Technical Details

The redirect_uri flow works like this:

1. Script starts local HTTP server on port (e.g., 8080)
2. Browser redirects to `http://localhost:8080?code=...` after sign-in
3. Script captures the authorization code
4. Script exchanges code for access token

If the port isn't registered in Google Cloud Console, Google rejects the request before the redirect even happens.

---

**Questions?** Check the error message for exact redirect_uri it's trying to use, then make sure that exact URI is registered in Google Cloud Console.
