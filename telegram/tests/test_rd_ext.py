import asyncio
from patchright.async_api import async_playwright

async def main():
    user_data_dir = r"C:\Users\Administrator\Desktop\Github Repos\python-zipper\.browser_profile"
    async with async_playwright() as p:
        print("Launching browser...")
        context = await p.chromium.launch_persistent_context(
            channel="chrome",                 # Uses your stable Google Chrome app binary
            headless=False,                  # OPENS THE BROWSER VISUALLY
            no_viewport=True,
            user_data_dir=user_data_dir,
            executable_path=r"C:\Users\Administrator\AppData\Local\ms-playwright\chromium-1228\chrome-win64\chrome.exe",
            artifacts_dir=r"G:\artifacts"
        )
        print("Browser launched.")
        page = await context.new_page()
        
        async def on_req(req):
            if "real-debrid" in req.url:
                print("RD HTTP:", req.url)
        page.on("request", on_req)
        
        print("Going to a test rentry page or mega URL...")
        # Since I don't have a real Mega URL handy, just open mega.nz
        await page.goto("https://mega.nz/")
        await asyncio.sleep(5)
        await context.close()

if __name__ == '__main__':
    asyncio.run(main())
