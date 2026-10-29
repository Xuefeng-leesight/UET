"""Optional Playwright test; not a production runtime dependency."""

import argparse
import json
from pathlib import Path

from playwright.sync_api import sync_playwright


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", required=True)
    parser.add_argument("--browser-binary")
    parser.add_argument("--screenshots", required=True, type=Path)
    args = parser.parse_args()
    args.screenshots.mkdir(parents=True, exist_ok=True)
    errors = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True, executable_path=args.browser_binary)
        try:
            page = browser.new_page(viewport={"width": 1280, "height": 900})
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.goto(args.url)
            page.wait_for_load_state("networkidle")
            page.wait_for_function("() => document.querySelector('#image').naturalWidth > 0")
            page.screenshot(path=str(args.screenshots / "pupil-preview-desktop.png"), full_page=True)
            assert "LIVE" in page.locator("#status").inner_text()
            assert "模拟数据" in page.locator("#source").inner_text()
            assert page.locator("#size").inner_text() == "640 × 360"
            assert page.locator("#image").evaluate("image => image.naturalWidth") == 640
            page.get_by_role("button", name="重新连接预览 ↗").click()
            page.wait_for_function("() => document.querySelector('#image').naturalWidth > 0")
            page.set_viewport_size({"width": 390, "height": 844})
            page.screenshot(path=str(args.screenshots / "pupil-preview-mobile.png"), full_page=True)
            assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")
            assert not errors, errors
            print(json.dumps({"browser_preview": "passed", "source": "SIMULATED", "page_errors": errors}))
        finally:
            browser.close()


if __name__ == "__main__":
    main()
