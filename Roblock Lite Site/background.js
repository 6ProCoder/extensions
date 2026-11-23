// Header rule so the Roblox auth-ticket endpoint accepts requests from the extension
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

// Runs only when you click the icon. Opens or focuses the Lite Site.
chrome.action.onClicked.addListener(async () => {
  const url = chrome.runtime.getURL("lite.html#home");
  const [tab] = await chrome.tabs.query({ url });
  if (tab) {
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  } else {
    chrome.tabs.create({ url });
  }
});

// Show a desktop notification when requested by lite.js
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "NOTIFY_PLAYTIME") {
    chrome.notifications.create("playtime-limit-" + Date.now(), {
      type: "basic",
      iconUrl: msg.iconUrl || chrome.runtime.getURL("icons/icon128.png"),
      title: "⏰ Playtime Reminder",
      message: msg.text,
      priority: 2
    });
  }
});