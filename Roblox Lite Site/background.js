// Ρύθμιση header rule ώστε το Roblox auth-ticket endpoint να δέχεται αιτήματα από το extension
async function setupAuthTicketRule() {
  const ruleId = 1001;
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [ruleId],
    addRules: [
      {
        id: ruleId,
        priority: 1,
        action: {
          type: "modifyHeaders",
          requestHeaders: [
            { header: "Origin", operation: "set", value: "https://www.roblox.com" },
            { header: "Referer", operation: "set", value: "https://www.roblox.com/" }
          ]
        },
        condition: {
          urlFilter: "||auth.roblox.com/v1/authentication-ticket",
          resourceTypes: ["xmlhttprequest"]
        }
      }
    ]
  });
}

chrome.runtime.onInstalled.addListener(setupAuthTicketRule);
chrome.runtime.onStartup.addListener(setupAuthTicketRule);
setupAuthTicketRule();

// Τρέχει μόνο όταν πατάς το εικονίδιο. Ανοίγει ή εστιάζει το Lite Site.
chrome.action.onClicked.addListener(async () => {
  const url = chrome.runtime.getURL("lite.html");
  const [tab] = await chrome.tabs.query({ url });
  if (tab) {
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  } else {
    chrome.tabs.create({ url });
  }
});

// Αποστολή Desktop Notification κατόπιν αιτήματος από το lite.js
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "NOTIFY_PLAYTIME") {
    chrome.notifications.create("playtime-limit-" + Date.now(), {
      type: "basic",
      iconUrl: msg.iconUrl || "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      title: "⏰ Όριο Χρόνου Gaming",
      message: msg.text,
      priority: 2
    });
  }
});