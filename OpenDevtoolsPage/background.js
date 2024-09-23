console.log("Hello background.js");

// #region 全局变量定义

let settings = {
    /** 默认的浏览器远程调试的端口 */
    web_socket_port: 9222,
    /** 默认的 CDP server 的端口 */
    cdp_server_port: 9221,
    /** 默认的 debugger 名称*/
    debugger_name: "lovedebug"
};

// 此处仅声明为全局变量，实际值在 updateApi 函数中初始化
/** 对应 inspector.html 的链接 */
let target_inspector = "";
/** 默认的 websocket 调试链接，还需要加上 frame id 才行 */
let debugApi = "";
/** 访问 /json/list api 获取当前浏览器的 tab 页信息 */
let jsonListApi = "";

/** 记录哪些 tab 页打开了控制台界面（tabid -> window id） */
const tabToDebugger = new Map();
/** 记录打开的控制台界面属于哪个 tab 打开的 ( window id -> tab id) */
const debuggerToTab = new Map();

// #endregion 全局变量定义


init();


// #region 辅助函数

/** 从存储中读取内容初始化全局变量 */
async function init() {
    settings.web_socket_port = await get("web_socket_port") || settings.web_socket_port;
    settings.cdp_server_port = await get("cdp_server_port") || settings.cdp_server_port;
    settings.debugger_name = await get("debugger_name") || settings.debugger_name;
    updateApi();
    console.log("init complete:", settings);
}

/** 更新 api */
function updateApi() {
    // 浏览器自带的 devtools，等到将来 bug 修复时再使用吧
    // target_inspector = 'devtools://devtools/bundled/devtools_app.html';
    // 远程调试时的 devtools
    target_inspector = `http://localhost:${settings.web_socket_port}/devtools/devtools_app.html`;
    debugApi = `${target_inspector}?ws=localhost:${settings.cdp_server_port}`
    jsonListApi = `http://localhost:${settings.web_socket_port}/json/list`;

    console.log("init debugApi:", debugApi);
    console.log("init jsonListApi:", jsonListApi);
}

/** 弹出通知咯 */
async function showNotification(title, message) {
    chrome.notifications.create({
        type: "basic",
        iconUrl: "icons/logo-64.png",
        title,
        message
    });
}

/** 从 storage local 中获取键值对，值不存在则返回 undefined 哟 */
async function get(key) {
    const result = await chrome.storage.local.get(key);
    result[key] && console.log("Get storage local: ", key, ' -> ', result[key]);
    return result[key];
}

function isNewtab(tabUrl) {
    return tabUrl === "chrome://newtab/" || tabUrl === "edge://newtab/";
}

/** 这个 tab 页面是否可以进行操作。返回 true 表示可以。
 * 
 * 默认情况下只能操作 `http/https/file` 页面、`newtab` 页面，其它都不行
 */
function isGoodTab(tabUrl) {
    const isHttpOrFile = tabUrl.startsWith("http") || tabUrl.startsWith("file");
    return isNewtab(tabUrl) || isHttpOrFile;
}

// #endregion 辅助函数


// #region tab页和对应的调试窗口的处理


// 点击插件时，需要打开控制台界面
chrome.action.onClicked.addListener(async (tab) => {
    const tabUrl = tab.url;
    const tabId = tab.id;
    const tabTitle = tab.title;

    if (tabToDebugger.has(tabId)) {
        const msg = `当前页面 [${tabTitle}] 已经打开了调试界面，无法重复打开`;
        console.warn(msg + ` Url: ${tabUrl}`);
        return await showNotification("Oops", msg);
    }

    if (!isGoodTab(tabUrl)) {
        const msg = `当前页面 [${tabTitle}] 不是 http/https/file 链接或 newtab 页面，无法打开调试界面`;
        console.warn(msg + ` Url: ${tabUrl}`);
        return await showNotification("Sorry", msg);
    }

    // 获取到了当前标签页顶层的 frameId，也就是 socket id
    let frameId = await getTargetId(tabUrl);

    if (frameId === 0) {
        return await showNotification("Error", "获取当前页面的调试信息失败，检查远程调试是否开启、端口是否正确");
    }

    // 然后打开调试界面咯
    // newtab 页面还是不要注入脚本了容易出错
    if (!isNewtab(tabUrl)) { await enableMyDebugger(tabId); }

    const debugUrl = `${debugApi}/${frameId}`;
    const win = await chrome.windows.create({ url: debugUrl, type: 'popup' });
    if (win) {
        tabToDebugger.set(tabId, win.id);
        debuggerToTab.set(win.id, tabId);
        console.log(`成功打开调试界面 [${tabTitle}] id: [${tabId}]，Url: ${tabUrl}`);
    } else {
        const msg = "打开调试界面失败"
        console.warn(msg);
        showNotification("Error", msg);
    }
});


/** 获取页面的 websocket 链接 id —— 也就是 frame id，以前是使用 debugger api 获取，现在可以不用
 * 
 * 经过测试发现，开启远程调试端口后，访问 `http://localhost:9222/json/list` 得到的列表中，
 * 似乎是按照 **访问的先后顺序排列的**。即如果有两个相同的 newtab 页面，那个排在第一个的 newtab 页面
 * 就是当前访问（或者刚才访问过的那个）的。
 * 
 * 所以可以这样做，当点击插件时就访问 /json/list，根据 tab url 匹配出第一个结果，
 * 然后获取到它的 id 就行啦
 */
async function getTargetId(tabUrl) {
    const result = await fetch(jsonListApi).then(res => res.json())
        .catch(err => { console.warn(`Get /json/list faild: ${err}`); return []; });
    // result 是一个数组，包含了多个 frame 的相关信息
    for (const item of result) {
        // type 的取值很多，没找到文档，只好猜测了
        // - page 表示标签页
        // - iframe 表示网页的 iframe 咯，即内嵌网页
        if (item.url === tabUrl && item.type === 'page') {
            return item.id;
        }
    }
    return 0;
}


// background.js 不能调用 eval，为了动态生成函数，可以让 contentScript 调用 eval
function toogle_debugger(code, cancel, debugger_name) {
    // 这是提前注入的内容
    if (window.sjd) {
        sjd.log && !cancel && sjd.log("OpenDevtoolsPage enable my debuger:", debugger_name)
        sjd.eval && sjd.eval(code);
    }
}


/** 启动自定义的 debugger 函数，默认名称为 lovedebug。
 * 如果当前页面是 newtab 页面，则不能注入哟
*/
async function enableMyDebugger(tabId, cancel = false) {
    const n = settings.debugger_name;
    let code = `window["${n}"] = (function ${n}() { debugger; })`;
    if (cancel) {
        code = `window["${n}"] = (function ${n}() { })`;
    }

    chrome.scripting.executeScript({
        target: { tabId },
        injectImmediately: true, // 立即注入
        world: "MAIN", // 和页面 JS 同环境
        function: toogle_debugger,
        args: [code, cancel, n]
    });
}


// 监听 tab 页的刷新，注入自定义的 debugger
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    if (!isGoodTab(tab.url)) { return; }

    if (changeInfo.status === 'loading') {
        // 如果已经打开了控制台界面，重新注入自定义的 debugger
        if (tabToDebugger.has(tabId)) {
            console.log(`[${tab.title}] id [${tabId}] 页面刷新了，注入自定义的 debugger`);
            await enableMyDebugger(tabId);
        } else {
            // 否则，需要注入一个空的，防止用户脚本出问题
            await enableMyDebugger(tabId, true);
        }
    }
});


// 监听 tab 页的关闭，如果已经打开了控制台界面，则同时关闭控制台界面
chrome.tabs.onRemoved.addListener(async (tabId, removeInfo) => {
    if (tabToDebugger.has(tabId)) {
        const windowId = tabToDebugger.get(tabId);
        chrome.windows.remove(windowId);
        console.log(`id [${tabId}] 页面关闭了，同时关闭了调试界面`);
        tabToDebugger.delete(tabId);
        debuggerToTab.delete(windowId);
    }
})


// 监听控制台页面页的关闭，需要取消对应 tab 页的自定义的 debugger
chrome.windows.onRemoved.addListener(async (windowId) => {
    // 这个 window 属于控制台界面
    if (debuggerToTab.has(windowId)) {
        const tabId = debuggerToTab.get(windowId);
        await enableMyDebugger(tabId, true);
        // 清空记录咯
        debuggerToTab.delete(windowId);
        tabToDebugger.delete(tabId);
        console.log(`id [${tabId}] 关闭了控制台界面，重新注入空的自定义 debugger`)
    }
});

//#endregion tab页和对应的调试窗口的处理


// 监听 local storage 的改变，更新对应的变量
chrome.storage.local.onChanged.addListener((changes, namespace) => {
    let updated = false;
    for (const [key, { oldValue, newValue }] of Object.entries(changes)) {
        console.log("Change settings: ", key, ' -> ', newValue);
        if (key in settings) {
            settings[key] = newValue;
            updated = true;
        }
    }
    updated && updateApi();
});