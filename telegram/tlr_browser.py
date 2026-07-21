"""
Browser automation helpers extracted from telethon_link_resolver.py.
Includes file download, CAPTCHA solving, and URL resolution via browser.
"""

import os
import asyncio
import random


async def download_file_with_browser(download_url, filename, browser, item_idx,
                                       download_dir=None, current_run_files=None):
    """Downloads file from unrestricted URL using browser (in headless mode)"""
    try:
        print(f"   [{item_idx}] Downloading: {filename}")

        page = await browser.new_page()

        download = None
        async with page.expect_download() as dl_promise:
            try:
                await page.goto(download_url, timeout=15000)
            except Exception:
                pass

            try:
                download = await asyncio.wait_for(dl_promise.value, timeout=30.0)
            except asyncio.TimeoutError:
                raise Exception("Download did not start within 30 seconds")

        output_path = os.path.join(download_dir, filename)
        await download.save_as(output_path)

        file_size = os.path.getsize(output_path)
        print(f"   [{item_idx}] ✓ Downloaded: {filename} ({file_size / (1024**3):.2f} GB)")

        if current_run_files is not None:
            current_run_files.add(output_path)

        await page.close()
        return output_path

    except asyncio.TimeoutError:
        print(f"   [{item_idx}] ✗ Download timeout")
        return None
    except Exception as e:
        print(f"   [{item_idx}] ✗ Download failed: {str(e)[:80]}")
        return None


async def solve_specific_captcha(page, page_idx, artifacts_dir=None):
    """Solves RGS CAPTCHA by finding and dragging DRAG/DROP targets"""
    try:
        print(f"   [{page_idx}] ========== SOLVING RGS CAPTCHA ==========")

        if artifacts_dir:
            debug_initial = os.path.join(artifacts_dir, f"debug_captcha_initial_{page_idx}.png")
            await page.screenshot(path=debug_initial)
            print(f"   [{page_idx}] Initial state: {debug_initial}")

        await page.wait_for_timeout(2000)

        print(f"   [{page_idx}] Looking for 'Start' button inside shadowRoot...")
        start_btn = await page.evaluate("""
            () => {
                let container = document.querySelectorAll("[id*=rgs]");
                if (container.length === 0) {
                    return { found: false, error: 'No rgs element found' };
                }
                for (let elem of container) {
                    if (!elem.shadowRoot) continue;
                    let buttons = elem.shadowRoot.querySelectorAll('button');
                    for (let btn of buttons) {
                        if (btn.innerText && btn.innerText.trim() === 'Start') {
                            const rect = btn.getBoundingClientRect();
                            return {
                                x: rect.x + (rect.width / 2),
                                y: rect.y + (rect.height / 2),
                                found: true,
                                buttonText: btn.innerText.trim()
                            };
                        }
                    }
                }
                return { found: false, error: 'Start button not found in shadowRoot' };
            }
        """)

        if not start_btn.get('found'):
            print(f"   [{page_idx}] ⚠️  'Start' button not found in shadowRoot")
            return False

        print(f"   [{page_idx}] ✓ Found 'Start' button at ({start_btn['x']:.0f}, {start_btn['y']:.0f})")
        await page.mouse.click(start_btn['x'], start_btn['y'])
        await page.wait_for_timeout(2000)

        if artifacts_dir:
            debug_after_start = os.path.join(artifacts_dir, f"debug_captcha_after_start_{page_idx}.png")
            await page.screenshot(path=debug_after_start)

        print(f"   [{page_idx}] Looking for RGS CAPTCHA structure...")
        targets = await page.evaluate("""
            () => {
                const rgsElem = document.querySelector('[id^="rgs-"]');
                if (!rgsElem) return { error: 'No rgs element' };
                if (!rgsElem.shadowRoot) return { error: 'No shadowRoot' };
                let node = rgsElem.shadowRoot;
                if (node.childNodes.length < 1) return { error: 'shadowRoot has no children' };
                node = node.childNodes[0];
                if (!node.childNodes || node.childNodes.length < 1) return { error: 'First child has no children' };
                node = node.childNodes[0];
                if (!node.childNodes || node.childNodes.length < 3) return { error: `Second child has ${node.childNodes?.length || 0} children` };
                const container = node.childNodes[2];
                if (!container.childNodes || container.childNodes.length < 2) return { error: `Container has ${container.childNodes?.length || 0} children` };
                const dropTarget = container.childNodes[0];
                const dragTarget = container.childNodes[1];
                const dropRect = dropTarget.getBoundingClientRect();
                const dragRect = dragTarget.getBoundingClientRect();
                return {
                    drop: { x: dropRect.x + (dropRect.width / 2), y: dropRect.y + (dropRect.height / 2), width: dropRect.width, height: dropRect.height },
                    drag: { x: dragRect.x + (dragRect.width / 2), y: dragRect.y + (dragRect.height / 2), width: dragRect.width, height: dragRect.height }
                };
            }
        """)

        if 'error' in targets:
            print(f"   [{page_idx}] ⚠️  Navigation failed: {targets['error']}")
            return False

        print(f"   [{page_idx}] ✓ DROP TARGET at ({targets['drop']['x']:.0f}, {targets['drop']['y']:.0f})")
        print(f"   [{page_idx}] ✓ DRAG TARGET at ({targets['drag']['x']:.0f}, {targets['drag']['y']:.0f})")

        start_x = targets['drag']['x']
        start_y = targets['drag']['y']
        end_x = targets['drop']['x']
        end_y = targets['drop']['y']

        print(f"   [{page_idx}] Dragging from ({start_x:.0f}, {start_y:.0f}) → ({end_x:.0f}, {end_y:.0f})")

        await page.mouse.move(start_x, start_y)
        await page.mouse.down()

        num_steps = 35
        for step in range(num_steps):
            progress = step / (num_steps - 1) if num_steps > 1 else 1.0
            current_x = start_x + (end_x - start_x) * progress
            current_y = start_y + (end_y - start_y) * progress
            await page.mouse.move(current_x, current_y)
            await page.wait_for_timeout(100)

        await page.mouse.up()
        print(f"   [{page_idx}] ✓ Drag completed!")

        await page.wait_for_timeout(1000)
        if artifacts_dir:
            debug_after = os.path.join(artifacts_dir, f"debug_rgs_after_{page_idx}.png")
            await page.screenshot(path=debug_after)

        print(f"   [{page_idx}] ========== RGS CAPTCHA SOLVED ==========")
        return True

    except Exception as e:
        print(f"   [{page_idx}] RGS CAPTCHA solve failed: {str(e)}")
        import traceback
        traceback.print_exc()
        return False


async def resolve_url_with_browser(url, context, page_idx, artifacts_dir=None,
                                     stealth_cls=None, captcha_solver_fn=None):
    """Clicks CTA via headless browser, handles the new tab, and extracts the first mega.nz target."""
    page = None
    try:
        page = await context.new_page()

        if stealth_cls:
            await stealth_cls().apply_stealth_async(page)

        print(f"   [{page_idx}] Navigating to webpage...")
        await page.goto(url, wait_until="domcontentloaded", timeout=30000)

        await page.evaluate("""
            () => {
                document.body.style.zoom = '100%';
                window.devicePixelRatio = 1.0;
            }
        """)

        delay = random.uniform(2.5, 4.5)
        print(f"   [{page_idx}] Page loaded. Allowing {delay:.2f}s for full render...")
        await asyncio.sleep(delay)

        try:
            print(f"   [{page_idx}] Looking for #cta-button...")
            btn = await page.wait_for_selector('#cta-button', timeout=8000)

            if btn:
                print(f"   [{page_idx}] Hovering over #cta-button...")
                await btn.hover()
                await asyncio.sleep(random.uniform(0.5, 1.5))

                if artifacts_dir:
                    debug_before = os.path.join(artifacts_dir, f"debug_before_click_{page_idx}.png")
                    await page.screenshot(path=debug_before)

                print(f"   [{page_idx}] Emulating click on #cta-button...")
                async with context.expect_page(timeout=15000) as new_page_info:
                    await btn.click(delay=random.randint(50, 200), force=True)

                print(f"   [{page_idx}] Intercepted popup! Waiting for it to stabilize...")
                popup = await new_page_info.value
                await popup.wait_for_load_state("domcontentloaded")
                await asyncio.sleep(3)

                if 'mega.nz' in popup.url:
                    result = popup.url
                    print(f"   [{page_idx}] ✓ Found mega.nz in popup URL: {result}")
                    await asyncio.sleep(5)
                    return result

                print(f"   [{page_idx}] Scraping anchor tags from popup for mega.nz links...")
                hrefs = await popup.evaluate("() => Array.from(document.querySelectorAll('a')).map(a => a.href)")

                result = popup.url
                for href in hrefs:
                    if 'mega.nz' in href:
                        result = href
                        break

                await asyncio.sleep(10)
                return result

        except Exception as inner_e:
            print(f"   [{page_idx}] CTA extraction phase failed: {type(inner_e).__name__} - {str(inner_e)}")
            if captcha_solver_fn:
                print(f"   [{page_idx}] Attempting to solve RGS CAPTCHA...")
                captcha_solved = await captcha_solver_fn(page, page_idx)
                if captcha_solved:
                    print(f"   [{page_idx}] CAPTCHA solved! Retrying button click...")
                    try:
                        btn = await page.query_selector('#cta-button')
                        if btn:
                            async with context.expect_page(timeout=15000) as new_page_info:
                                await btn.click(delay=random.randint(50, 200), force=True)
                            popup = await new_page_info.value
                            await popup.wait_for_load_state("domcontentloaded")
                            await asyncio.sleep(2)
                            if 'mega.nz' in popup.url:
                                await popup.close()
                                return popup.url
                            hrefs = await popup.evaluate("() => Array.from(document.querySelectorAll('a')).map(a => a.href)")
                            for href in hrefs:
                                if 'mega.nz' in href:
                                    await popup.close()
                                    return href
                            await popup.close()
                    except Exception as retry_e:
                        print(f"   [{page_idx}] Retry failed: {str(retry_e)}")

            if artifacts_dir:
                debug_img = os.path.join(artifacts_dir, f"debug_popup_{page_idx}.png")
                await page.screenshot(path=debug_img)

        print(f"   [{page_idx}] Proceeding to fallback inline anchor scraping on main page...")
        hrefs = await page.evaluate("() => Array.from(document.querySelectorAll('a')).map(a => a.href)")

        for href in hrefs:
            if 'mega.nz' in href:
                return href

        return page.url

    except Exception as e:
        print(f"   [{page_idx}] Fatal failure processing URL {url}: {str(e)}")
        if page and artifacts_dir:
            fatal_img = os.path.join(artifacts_dir, f"debug_fatal_{page_idx}.png")
            await page.screenshot(path=fatal_img)
        return url
    finally:
        if page:
            await page.close()
