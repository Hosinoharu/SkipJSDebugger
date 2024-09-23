// ==UserScript==
// @name         跳过反调试检测
// @namespace    http://tampermonkey.net/
// @version      2024-09-15
// @description  支持控制台 Console API 检测、报错式检测。
// @author       You
// @match        https://*/*
// @match        http://*/*
// @exclude      http://localhost:*/devtools/devtools_app.html*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(() => {
    'use strict';

    const sjd_symbol = Symbol.for("sjd");
    /** 该值为 true 表示启用 hook，为 false 表示禁用 hook */
    window[sjd_symbol] = true;

    //#region 保留一份便于自己使用

    const mylog = console.log;
    window.mylog = mylog;  // 暴露到外部去，方便调试
    const raw_proxy = Proxy;

    //#endregion

    /** 记录 Hook 的对象以及对象的原来的对象 */
    const hooked_objects = new WeakMap();


    // #region Hook逻辑 处理检测方式

    /** 创建 proxy 进行函数的 hook，默认情况下相当于置空函数。
     * 
     * 传入 hooked_func 参数可以替换函数的调用逻辑。
     * 
     * hooked_func 参数的格式为：`(target, thisArg, ...args)`
     * - `target`: 原函数，通过它可以调用被 hook 的函数
     * - `thisArg`: 调用函数时的 this，如果需要调用原函数，应该以此为 this
     * - `args`: 调用函数时的参数，接收多个参数哟
     */
    function create_func_proxy(obj, hooked_func = null) {
        if (typeof obj !== 'function') {
            throw new Error("anti devtools detector errror: object is not a function");
        }
        const hooker = new raw_proxy(obj, {
            apply(target, thisArg, args) {
                // this 参数可能是 proxy 对象哟
                if (hooked_objects.has(thisArg)) {
                    thisArg = hooked_objects.get(thisArg);
                }
                // 启用了 hook 功能
                if (window[sjd_symbol]) {
                    if (hooked_func) {
                        const n = [target, thisArg, ...args];
                        return Reflect.apply(hooked_func, undefined, n);
                    }
                    return;  // 此处相当于置空函数，但是返回值固定为 undefined 哟
                }
                return Reflect.apply(target, thisArg, args);
            }
        });
        hooked_objects.set(hooker, obj);
        return hooker;
    }

    /** 使得网站的 console 失效 */
    function disable_console() {
        for (const n of Object.getOwnPropertyNames(console)) {
            if (typeof console[n] === 'function') {
                console[n] = create_func_proxy(console[n]);
            }
        }
    }

    /** 过掉报错式检测。也许需要 hook defineProperties 呢？？暂定。先这样吧 */
    function hook_defineProperty() {

        /** 对其属性描述符进行检测，如果发现可疑目标，返回空的属性描述符，否则原样返回 */
        function check_descriptor(obj, prop, descriptor) {
            if (obj instanceof Error) {
                const getter = descriptor.get;
                if (getter) {
                    mylog(`Warnning! Hook defineProperty, Property: ${prop.toString()}, Getter: `, getter.toString());
                    // 将 getter 设置为空函数
                    descriptor.get = create_func_proxy(getter);
                }
            }
            return descriptor;
        }

        function my_defineProperty(target, thisArg, ...args) {
            let [obj, prop, descriptor] = args;
            descriptor = check_descriptor(obj, prop, descriptor);
            return target.call(thisArg, obj, prop, descriptor);
        }

        function my_defineGetter(target, thisArg, ...args) {
            let [prop, getter] = args;
            if (thisArg instanceof Error) {
                mylog(`Warnning! Hook __defineGetter__, Property: ${prop.toString()}, Getter: `, getter.toString());
                // 将 getter 设置为空函数
                getter = create_func_proxy(getter);
            }
            return target.call(thisArg, prop, getter);
        }

        Object.defineProperty = create_func_proxy(Object.defineProperty, my_defineProperty);
        Object.prototype.__defineGetter__ = create_func_proxy(Object.prototype.__defineGetter__, my_defineGetter);
    }

    /** 解决 toString 检测、 toString 的原型链检测 */
    function hook_Function_prototype_toString() {
        function toString(target, thisArg, ...args) {
            return target.call(thisArg, ...args);
        }
        Function.prototype.toString = create_func_proxy(Function.prototype.toString, toString);
    }


    function main() {
        disable_console();
        hook_defineProperty();
        hook_Function_prototype_toString();

        mylog(`
%c[☆] Anti Devtools Detector start on: [${location.href}]

%c\t请注意：如果网站部分功能异常，请停止运行本脚本!\n`,
            "color:orange",
            "color: #ff2d51;font-weight: bold;");  // 火红
    }

    // #endregion Hook逻辑


    window[sjd_symbol] && main();
})();