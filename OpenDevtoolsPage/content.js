// 提前保存一些东西，便于插件使用
(() => {
    window.sjd = {
        log: console.log,
        eval: eval,
    };
})();