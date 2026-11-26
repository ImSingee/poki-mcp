import XCTest

/// Black-box acceptance automation for the owner-facing OpenRouter model list.
final class ModelOpenRouterUITests: XCTestCase {
    private func screenshot(_ app: XCUIApplication, name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    func testOpenRouterTickListShowsGPT62SolAndAstra() {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["-pokiScreen", "model", "-AppleLanguages", "(en)", "-AppleLocale", "en_US"]
        app.launch()

        let openRouter = app.buttons.matching(NSPredicate(format: "label BEGINSWITH[c] %@", "OpenRouter")).firstMatch
        if !openRouter.waitForExistence(timeout: 3) {
            let add = app.buttons["models.provider.add"]
            XCTAssertTrue(add.waitForExistence(timeout: 15))
            add.tap()

            let addOpenRouter = app.buttons.matching(NSPredicate(format: "label BEGINSWITH[c] %@", "OpenRouter")).firstMatch
            XCTAssertTrue(addOpenRouter.waitForExistence(timeout: 5))
            addOpenRouter.tap()

            let keyField = app.secureTextFields.firstMatch
            XCTAssertTrue(keyField.waitForExistence(timeout: 5))
            keyField.tap()
            keyField.typeText("sk-or-acceptance-fixture")
            let save = app.buttons.matching(NSPredicate(format: "label IN %@", ["Save", "保存", "儲存"])).firstMatch
            XCTAssertTrue(save.waitForExistence(timeout: 5))
            save.tap()
            // Save writes the key synchronously before the connection probe. End that probe with the
            // process; the next launch exercises the saved account rather than OpenRouter's live API.
            Thread.sleep(forTimeInterval: 0.8)
            app.terminate()
            app.launch()
        }

        let account = app.buttons.matching(NSPredicate(format: "label BEGINSWITH[c] %@", "OpenRouter")).firstMatch
        XCTAssertTrue(account.waitForExistence(timeout: 15))
        account.tap()

        let chat = app.descendants(matching: .any)["provider.use.chat"]
        XCTAssertTrue(chat.waitForExistence(timeout: 10))
        chat.tap()

        let sol = app.descendants(matching: .any)
            .matching(NSPredicate(format: "label == %@", "GPT-6.2 Sol (OpenRouter)")).firstMatch
        let astra = app.descendants(matching: .any)
            .matching(NSPredicate(format: "label == %@", "GPT-6.2 Astra (OpenRouter)")).firstMatch
        for _ in 0..<8 where !sol.waitForExistence(timeout: 1) { app.swipeUp() }
        XCTAssertTrue(sol.waitForExistence(timeout: 5))
        XCTAssertTrue(astra.waitForExistence(timeout: 5))
        XCTAssertTrue(sol.isHittable)
        XCTAssertTrue(astra.isHittable)
        screenshot(app, name: "OpenRouter GPT-6.2 model rows")
    }
}
