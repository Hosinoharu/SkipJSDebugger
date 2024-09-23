MYDEBUGGER_NAME = "lovedebug"
"自定义的 debugger 名称，如果要手动修改这里，还需要修改很多地方，具体看文档说明"

CDP_SERVER_PORT = 9221
"监听 devtools 端连接的端口"

WEB_SOCKET_PORT = 9222
"浏览器远程调试的端口"

WEB_SOCKET_DEBUG_API = f"ws://localhost:{WEB_SOCKET_PORT}/devtools/page" + "{socket_id}"
