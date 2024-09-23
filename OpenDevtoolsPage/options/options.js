const inputs = document.querySelectorAll('input');
const reset = document.querySelector('#reset');


init();


async function init() {
    // 从存储中读取内容并填充到页面中哟
    inputs.forEach(async (input) => {
        // 获取当前 input 元素的 id
        const id = input.id;
        const value = await get(id);
        value && (input.value = value);
    });

    // 绑定事件
    inputs.forEach(input => {
        input.addEventListener('change', () => {
            save(input.id, input.value);
        });
    });

    reset.addEventListener('click', () => {
        chrome.storage.local.clear();
    });
}

/** 保存设置项到 storage local */
async function save(key, value) {
    chrome.storage.local.set({ [key]: value });
    console.log(`Save: ${key} -> ${value}`);
}

/** 从 storage local 中获取键值对，值不存在则返回 undefined 哟 */
async function get(key) {
    const result = await chrome.storage.local.get(key);
    result[key] && console.log("Get storage local: ", key, ' -> ', result[key]);
    return result[key];
}

window.addEventListener('beforeunload', function () {
    // 可能有这样的情况：输入内容之后直接关闭了网页，此时并没有触发 change 事件
    document.activeElement?.blur();
});