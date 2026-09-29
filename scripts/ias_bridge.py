import json
import os
import sys

# The project folder (with the log_ias_lab package) is passed by Nuvia as argv[3].
PROJECT = sys.argv[3] if len(sys.argv) > 3 else os.environ.get("NUVIA_IAS_PROJECT", os.getcwd())
sys.path.insert(0, PROJECT)

from log_ias_lab.log_lab import LogLab
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import Select


def emit(payload):
    print("NUVIA_JSON:" + json.dumps(payload, ensure_ascii=False))


def main():
    action = sys.argv[1] if len(sys.argv) > 1 else "list"
    requested = sys.argv[2] if len(sys.argv) > 2 else ""
    user = os.environ.get("DEI_USER")
    password = os.environ.get("DEI_PASSWORD")
    if not user or not password:
        emit({"ok": False, "message": "Credenziali DEI non configurate", "labs": []})
        return 2
    lab = LogLab(user, password, requested)
    driver = lab._set_driver()
    try:
        lab._login(driver)
        driver.get(lab.laboratory_url)
        exits = driver.find_elements(By.CSS_SELECTOR, "input[type='submit'][value^='Exit from']")
        if exits:
            emit({"ok": True, "alreadyInside": True, "message": "Sei già registrato in laboratorio", "labs": []})
            return 0
        selector = Select(driver.find_element(By.ID, "laboratory_id"))
        labs = [option.text.strip() for option in selector.options if option.get_attribute("value")]
        if action == "list":
            emit({"ok": True, "labs": labs})
            return 0
        if requested not in labs:
            emit({"ok": False, "labs": labs, "message": f"Laboratorio non disponibile: {requested}"})
            return 3
        selector.select_by_visible_text(requested)
        driver.find_element(By.CSS_SELECTOR, "input[type='submit'][value='Enter']").click()
        emit({"ok": True, "labs": labs, "message": f"Ingresso registrato in {requested}"})
        return 0
    except Exception as error:
        emit({"ok": False, "message": str(error), "labs": []})
        return 1
    finally:
        driver.quit()


if __name__ == "__main__":
    raise SystemExit(main())
