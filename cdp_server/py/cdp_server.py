"""
cdp_server 最初的 python 版本。

实现了一个 Chrome Devtools Protocol Proxy 服务器，用于转发 CDP 请求和响应，同时进行特定消息的拦截。
"""

import json
import dataclasses
import asyncio
import logging
import logging.handlers
from typing import Callable, Awaitable

from websockets.exceptions import (
    ConnectionClosed,
    ConnectionClosedError,
    ConnectionClosedOK,
)
from websockets.asyncio.server import serve
from websockets.asyncio.client import connect
from websockets.asyncio.connection import Connection

from settings import *


def get_logger():
    """将 >= INFO 级别的日志输出到控制台，将所有级别的日志输出到文件"""
    loger = logging.getLogger(__name__)
    loger.setLevel(logging.DEBUG)

    default_formatter = logging.Formatter(
        "[%(asctime)s] - %(levelname)s - %(message)s", datefmt="%Y-%m-%d %H:%M:%S"
    )

    # 记录 INFO 级别以上的日志
    default_handler = logging.StreamHandler()
    default_handler.setFormatter(default_formatter)
    default_handler.addFilter(lambda record: record.levelno >= logging.INFO)

    # 记录所有级别的日志，同时避免日志太多，每次启动服务器时清空文件
    file_handler = logging.handlers.RotatingFileHandler(
        "server.log", maxBytes=1024 * 1024, backupCount=1, encoding="utf8"
    )
    file_handler.setFormatter(default_formatter)

    loger.addHandler(default_handler)
    loger.addHandler(file_handler)

    return loger


# region #tag 变量类型定义

Author = "From 52pj"
Version = "0.0.1"
License = "MIT"

logger = get_logger()


@dataclasses.dataclass
class ConnectionInfo:
    cid: str
    "表示 websocket 连接的 id"
    des: str
    "表示连接的名称，或者描述性信息"


@dataclasses.dataclass
class DevtoolsToWebConnection:
    devtools: Connection | None = None
    "表示 devtools 端的 websocket 连接"
    web: Connection | None = None
    "表示 web 端的 websocket 连接"


CONNECTED_TARGET: set[str] = set()
"记录已经连接的 target 的 id，避免多个 devtools 调试同一个 web 端"


TransimiterHandler = Callable[[Connection, ConnectionInfo, str], Awaitable[str | None]]
"""
表示转发时的处理器类型。
接收一个 _from connection、一个连接的描述性信息，以及要处理的 message。
- 如果返回新的 message，则表示转发该 message。
- 如果返回 None 则表示不转发。

之所以传入了 connection 是因为可能要进行拦截、并返回给 _from 那一端。
"""

# endregion


async def transimiter(
    _from: Connection,
    _to: Connection,
    cinfo: ConnectionInfo,
    handler: TransimiterHandler | None = None,
):
    """
    数据转发，从 _from 转发到 _to，同时 handler 进行处理。

    :param _from: 数据来源
    :param _to: 数据去向
    :param cinfo: 这个连接的信息
    :param handler: 处理器。如果为 None 表示不进行处理，直接转发
    """
    info_prefix = f"[{cinfo.cid}] {cinfo.des}"

    try:
        async for message in _from:
            logger.debug(f"{info_prefix}: {message}")
            if handler:
                message = await handler(_from, cinfo, message)
            if message is not None:
                await _to.send(message)

    except (ConnectionClosed, ConnectionClosedOK, ConnectionClosedError):
        logger.error(f"{info_prefix} faild, because connection closed")

    except Exception as e:
        logger.error(f"{info_prefix} faild, unexpected error: {e}")

    finally:
        await _from.close()
        await _to.close()

    pass


# region #tag 处理web端发来的数据


async def handle_msg_from_devtools(
    _from: Connection, cinfo: ConnectionInfo, message: str
) -> str | None:
    if "Overlay.setPausedInDebuggerMessage" in message:
        message = message.replace(
            "Paused in debugger", f"Paused in debugger - Surprise {Author}", 1
        )
    return message


async def handle_msg_from_web(
    _from: Connection, cinfo: ConnectionInfo, message: str
) -> str | None:
    """
    处理 web 端发来的数据，目前只处理 Debugger.paused 消息。
        如果返回 None，则不转发给 devtools 端。
        否则返回新的数据，再转发给 devtools 端。
    """
    info_prefix = f"[{cinfo.cid}] web -> server"

    # 根据我的规范，所有 server 发过去的 id 都为从 0 开始的负数。
    # 如果 id 为 0 则舍弃消息，表示不需要转发
    if '"id":0' in message:
        logger.debug(f"{info_prefix}: (server drop id=0)")
        return None

    cdp_res = json.loads(message)
    # 存在没有该参数 "params" 的情况，所以忽略
    params = cdp_res.get("params")
    if (
        params
        and cdp_res.get("method") == "Debugger.paused"
        and await process_debugger_paused(_from, cinfo, params)
    ):
        logger.debug(f"{info_prefix}: (server ignore debugger paused): {message}")
        return None
    else:
        return message


async def process_debugger_paused(
    _from: Connection, cinfo: ConnectionInfo, params: dict
) -> bool:
    """
    处理 Debugger.paused 消息的内容。
        1. 返回 True 表示处理过了，此时对应的消息不再转发
        2. 返回 False 表示进行消息转发
    """
    info_prefix = f"[{cinfo.cid}] server -> web"

    # 情况有限，目前这种情况似乎由 js debugger 语句触发
    is_js_debugger = params.get("reason") == "other" and not params.get(
        "hitBreakpoints"
    )
    if not is_js_debugger:
        return False

    # 如果触发该 debugger 的函数名是 lovedebug（即自定义的 debugger 函数），那就不跳过
    # 但是为了让堆栈进入到正确位置，发送一个 Debugger.stepOut 回去
    if params.get("callFrames")[0].get("functionName") == MYDEBUGGER_NAME:
        logger.warning(
            f"{info_prefix}: debugger paused in my debugger {MYDEBUGGER_NAME}"
        )
        t = '{"id":0,"method":"Debugger.stepOut","params":{}}'
        logger.debug(f"{info_prefix}: Debugger.stepOut")
        await _from.send(t)
        return True

    else:
        # 发送一个 Debugger.resume 消息
        t = '{"id":0,"method":"Debugger.resume","params":{"terminateOnResume":false}}'
        logger.debug(f"{info_prefix}: Debugger.resume")
        await _from.send(t)
        return True


# endregion


# region #tag 启动服务器与处理连接


async def start_transmiter_task(devtools_socket: Connection, path: str):
    CONNECTED_TARGET.add(path)

    # 然后连接到 web 端
    debug_url = WEB_SOCKET_DEBUG_API.format(socket_id=path)
    logger.info(f"connect to web target: {path}")
    try:
        web_socket = await connect(debug_url)

    except Exception as e:
        logger.error(f"connect to web target failed: {e}")

    # 如果没有抛出异常则会执行 else 部分，否则不执行这里哟
    else:
        task1 = asyncio.create_task(
            transimiter(
                web_socket,
                devtools_socket,
                ConnectionInfo(path, "web --> devtools"),
                handle_msg_from_web,
            )
        )
        task2 = asyncio.create_task(
            transimiter(
                devtools_socket,
                web_socket,
                ConnectionInfo(path, "devtools --> web"),
                handle_msg_from_devtools,
            )
        )

        await asyncio.wait((task1, task2))
        await devtools_socket.wait_closed()
        await web_socket.wait_closed()

    # 断开后清空资源
    finally:
        CONNECTED_TARGET.remove(path)
        logger.info(f"clear resource for debug target: {path}")


async def websocket_handler(devtools_socket: Connection):
    """
    相当于路由处理，这里的 path 就是 web 端的 websocket 连接的 id。
    """
    path = devtools_socket.request.path
    logger.info(f"=> devtools try to debug target: {path}")

    # 重复的连接，简单起见直接阻止，而不是断开旧的连接
    if path in CONNECTED_TARGET:
        logger.warning(f"{path} already connected.")
        return

    # GOOD！启动 task 开始进行两端的转发
    await asyncio.create_task(start_transmiter_task(devtools_socket, path))


async def main():
    # 启动 websocket 服务器，监听 devtools 端的连接
    async with serve(websocket_handler, "localhost", CDP_SERVER_PORT):
        await asyncio.get_running_loop().create_future()  # run forever


# endregion


if __name__ == "__main__":
    info = f"""
Author: {Author}
Version: {Version}
License: {License}
======================================
CDP Server is running on port: {CDP_SERVER_PORT}
Browser remote debug port is: {WEB_SOCKET_PORT}
My debugger is: {MYDEBUGGER_NAME}
======================================
"""
    print(info)
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        logger.info("CDP Server is stopped.")
    except Exception as e:
        logger.error(f"CDP Server is stopped with error: {e}")
    finally:
        CONNECTED_TARGET.clear()
