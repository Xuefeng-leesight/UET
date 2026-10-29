"""Real new-project component regression; requires a Vite server, no hardware."""
import argparse
import json
from pathlib import Path

from playwright.sync_api import sync_playwright

parser = argparse.ArgumentParser()
parser.add_argument("--url", required=True)
parser.add_argument("--browser-binary")
parser.add_argument("--screenshot", type=Path)
args = parser.parse_args()
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, executable_path=args.browser_binary)
    try:
        page = browser.new_page(viewport={"width": 1280, "height": 900})
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.goto(args.url)
        page.wait_for_load_state("networkidle")
        page.get_by_role("dialog", name="新建工程").wait_for()
        assert not errors, errors
        print("Page text:", page.locator("body").inner_text()[:2000])
        print("Rendered buttons:", page.get_by_role("button").all_text_contents())
        page.get_by_role("button", name="桌面式眼动仪 Pro", exact=True).click()
        assert page.get_by_role("button", name="Tobii Pro Glasses 3", exact=True).is_disabled()
        assert page.get_by_role("button", name="Pupil Core", exact=True).is_enabled()
        page.get_by_role("button", name="Pupil Core", exact=True).click()
        if args.screenshot:
            page.screenshot(path=str(args.screenshot), full_page=True)
        for label, model, kind in [("Pupil Core", "PupilCore", "眼镜式"),
                                    ("桌面式眼动仪 Pro", "Pro", "桌面式"),
                                    ("桌面式眼动仪A8", "A8", "桌面式"),
                                    ("眼镜式眼动仪", "aSeeGlassesPlus", "眼镜式")]:
            if model != "PupilCore":
                page.get_by_role("button", name=previous_label, exact=True).click()
                page.get_by_role("button", name=label, exact=True).click()
            page.get_by_role("button", name="确认创建", exact=True).click()
            result = json.loads(page.get_by_test_id("project-result").text_content())
            assert result["deviceModel"] == model, result
            assert result["deviceType"] == kind, result
            assert result["modality"]["config"]["deviceModel"] == model, result
            previous_label = label
        assert not errors, errors
        print("Production project modal: PupilCore and legacy three models passed; no page errors.")
    finally:
        browser.close()
