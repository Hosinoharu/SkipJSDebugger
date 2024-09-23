// cdp_server.py 的 go 版本

package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"sync"

	"github.com/gorilla/websocket"
)

// #region 程序信息

var (
	Author  = "From 52pj"
	Version = "0.0.1"
	License = "MIT"

	// 自定义的 debugger 名称
	MYDEBUGGER_NAME string

	// 监听 devtools 端连接的端口
	CDP_SERVER_PORT uint

	// 浏览器远程调试的端口
	WEB_SOCKET_PORT uint

	// 浏览器远程调试的地址，需要指定浏览器远程调试端口。
	// 其形如 localhost:9222/devtools/page/{websocket_id}
	WEB_SOCKET_DEBUG_API string
)

// #endregion

// #region 定义CDP类型用于JSON解析

type DebuggerPausedParams struct {
	Reason         string   `json:"reason"`
	HitBreakpoints []string `json:"hitBreakpoints"`
	CallFrames     []struct {
		FunctionName string `json:"functionName"`
	} `json:"callFrames"`
}

type DebuggerPaused struct {
	Method string               `json:"method"`
	Params DebuggerPausedParams `json:"params"`
}

// #endregion

// #region 定义自己的类型

const buffer_size = 1024 * 1024

// 为了解决 panic: concurrent write to websocket connection 问题。
//
// 假设：
//
// - 现在有线程 1 进行： a.read() 得到消息 msg，然后 b.send(msg)
//
// - 现在有线程 2 进行： b.read() 得到消息 msg，然后 a.send(msg)
//
// 此时一切正常，不会发生 panic。但是涉及到消息拦截与回复，可能会出现这种情况：
//
// - 线程 2 中拦截消息，即 b.read() 得到消息 msg 后，服务器处理并伪造客户端响应 b.send(new_msg)
//
// - 此时，如果线程 1 中恰好也在 b.send(msg)，那么就会发生上述的 panic 啦。
//
// 解决方法有两种，考虑后将来的可复用性，选择使用通道。
// - 使用互斥锁。
// - 使用通道。
//
// 官方原文如下.
//
// Connections support one concurrent reader and one concurrent writer.
// Applications are responsible for ensuring that no more than one goroutine calls the write methods (NextWriter, SetWriteDeadline, WriteMessage, WriteJSON, EnableWriteCompression, SetCompressionLevel) concurrently and that no more than one goroutine calls the read methods (NextReader, SetReadDeadline, ReadMessage, ReadJSON, SetPongHandler, SetPingHandler) concurrently.
// The Close and WriteControl methods can be called concurrently with all other methods.
type MyWSConnection struct {
	// 该连接的名称，用于日志输出
	Name string
	// WebSocket 连接
	conn *websocket.Conn
	// 通过该通道指定要 Conn 发送的数据，默认缓冲大小是常量 buffer_size 的值
	msg_sender chan []byte
	// 通过该通道接收 Conn 发送的数据，默认缓冲大小是常量 buffer_size 的值
	msg_reciver chan []byte
	// 连接是否关闭
	is_closed bool
	// 互斥量，因为多个协程会访问 is_closed
	m sync.Mutex
}

func NewMyWSConnection(name string, conn *websocket.Conn) *MyWSConnection {
	c := &MyWSConnection{
		Name:        name,
		conn:        conn,
		msg_sender:  make(chan []byte, buffer_size),
		msg_reciver: make(chan []byte, buffer_size),
		is_closed:   false,
		m:           sync.Mutex{},
	}

	return c
}

// 是多线程安全的
func (c *MyWSConnection) is_Closed() bool {
	c.m.Lock()
	defer c.m.Unlock()
	return c.is_closed
}

// 开始工作
//
// - 从 msg_sender 通道接收数据，并使用 Conn 发送。
//
// - 从 Conn 接收数据，并写入到 msg_reciver 通道。
func (c *MyWSConnection) start() {
	defer c.Close()

	// 从 socket 读取数据似乎会阻塞，只好单独拿出去执行了
	go func() {
		defer c.Close()
		for {
			_, msg, err := c.conn.ReadMessage()
			if err != nil {
				logger.Error(c.Name + " ReadMessage failed: " + err.Error())
				return
			}
			if c.is_Closed() {
				return
			} else {
				c.msg_reciver <- msg
			}
		}
	}()

	for msg := range c.msg_sender {
		if c.is_Closed() {
			return
		}
		if err := c.conn.WriteMessage(websocket.TextMessage, msg); err != nil {
			logger.Error(c.Name + " WriteMessage failed: " + err.Error())
			return
		}
	}
}

// 可能阻塞，因为通道缓冲区满了
func (c *MyWSConnection) WriteMessage(msg []byte) error {
	if c.is_Closed() {
		return fmt.Errorf("%s connection closed", c.Name)
	}
	c.msg_sender <- msg
	return nil
}

// 可能阻塞，因为通道缓冲区是空的
func (c *MyWSConnection) ReadMessage() (msg []byte, err error) {
	if c.is_Closed() {
		return nil, fmt.Errorf("%s connection closed", c.Name)
	}
	msg = <-c.msg_reciver
	return msg, nil
}

func (c *MyWSConnection) Close() {
	c.m.Lock()
	defer c.m.Unlock()
	if !c.is_closed {
		logger.Warn(c.Name + " connection is closing")
		close(c.msg_sender)
		close(c.msg_reciver)
		c.is_closed = true
	}
	c.conn.Close()
}

type ConnectionInfo struct {
	// 表示 websocket 连接的 id
	cid string
	// 表示连接的名称，或者描述性信息
	des string
}

// 存储一对连接。因为 devtools 和 web 端的连接是成对出现的，所以使用一个 map 来存储。
// 并且后续会确保不会有 devtools 连接到同一个 web
type DevtoolsToWebConnection struct {
	Devtools *MyWSConnection
	Web      *MyWSConnection
}

type ConnectionPool map[string]*DevtoolsToWebConnection

// 记录已经连接的 target，避免重复连接 —— 多个 devtools 连接到同一个 web
type ConnectedTarget map[string]bool

/*
表示转发时的处理器类型。

接收一个 _from connection、一个连接的描述性信息，以及要处理的 message。

- 如果返回新的 (message, true)，则表示转发该 message。

- 如果返回 ([], false) 则表示不转发。

之所以传入了 connection 是因为可能要进行拦截、并返回给 _from 那一端。
*/
type TransimiterHandler = func(_from *MyWSConnection, cinfo *ConnectionInfo, msg []byte) (data []byte, is_ok bool)

// #endregion

// #region 全局变量

var CONNECTION_POOL = make(ConnectionPool)

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool {
		return true
	},
}

var logger *slog.Logger

//#endregion

func main() {
	// #region 初始化

	debugger := flag.String("debugger", "lovedebug", "The name of self-defined debugger")
	cdp := flag.Uint("cdp", 9221, "CDP Server port")
	port := flag.Uint("port", 9222, "Broswer's remote debug port")
	enable_log := flag.Bool("log", false, "Enable log, save to server.log file")

	flag.Parse()
	MYDEBUGGER_NAME = *debugger
	CDP_SERVER_PORT = uint(*cdp)
	WEB_SOCKET_PORT = uint(*port)
	WEB_SOCKET_DEBUG_API = fmt.Sprintf("ws://localhost:%d/devtools/page", WEB_SOCKET_PORT)

	// #endregion

	http.HandleFunc("/", websocket_handler)

	m := fmt.Sprintf(`
Author: %s
Version: %s
License: %s
======================================
CDP Server is running on port: %d
Browser remote debug port is: %d
My debugger is: %s
======================================
`, Author, Version, License, CDP_SERVER_PORT, WEB_SOCKET_PORT, MYDEBUGGER_NAME)
	fmt.Println(m)
	logger = init_logger(*enable_log)

	log.Fatal(http.ListenAndServe(fmt.Sprintf(":%d", CDP_SERVER_PORT), nil))
}

func init_logger(enable_log bool) *slog.Logger {
	var output io.Writer
	if enable_log {
		file, err := os.OpenFile("server.log", os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0666)
		if err != nil {
			log.Fatal("create log file faild: " + err.Error())
		}
		output = file
	} else {
		output = io.Discard
	}

	logger := slog.New(slog.NewTextHandler(output,
		&slog.HandlerOptions{
			Level: slog.LevelDebug,
		}),
	)

	return logger
}

func websocket_handler(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Path
	logger.Info("=> devtools try to debug target: " + path)

	// 避免多个 devtools 连接到同一个 web。必须手动关闭之前的那一个才行
	if CONNECTION_POOL[path] != nil {
		logger.Warn(path + " already connected")
		return
	}

	ws, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Fatal("upgrade websocket failed: " + err.Error())
	}
	devtools := NewMyWSConnection("devtools", ws)
	// 现在已经有了 devtools 端，可以开始连接 web 端，并进行任务
	go start_transmiter_task(devtools, path)
}

func start_transmiter_task(devtools *MyWSConnection, path string) {
	defer devtools.Close()

	logger.Info("connect to web target: " + path)

	// 连接、并创建 web 端
	debug_url := WEB_SOCKET_DEBUG_API + path
	ws, _, err := websocket.DefaultDialer.Dial(debug_url, nil)
	if err != nil {
		logger.Error("connect to web target failed: " + err.Error())
		return
	}
	web := NewMyWSConnection("web", ws)
	defer web.Close()

	// 现在已经有了 devtools 与 web 两端，可以开始转发数据了
	go devtools.start()
	go web.start()

	var wg sync.WaitGroup

	wg.Add(1)
	web_handler := TransimiterHandler(handle_msg_from_web)
	go transimiter(web, devtools, &ConnectionInfo{
		cid: path,
		des: "web -> devtools",
	}, &web_handler, &wg)

	wg.Add(1)
	devtools_handler := TransimiterHandler(handle_msg_from_devtools)
	go transimiter(devtools, web, &ConnectionInfo{
		cid: path,
		des: "devtools -> web",
	}, &devtools_handler, &wg)

	wg.Wait()

	// 清理资源
	delete(CONNECTION_POOL, path)
	logger.Info("clear resource for debug target: " + path)
}

// 转发器。从 _from 读取数据，并转发到 _to
// cinfo: 关于连接的信息
// handler: 处理函数
func transimiter(_from, _to *MyWSConnection, cinfo *ConnectionInfo, handler *TransimiterHandler, wg *sync.WaitGroup) {
	defer wg.Done()
	defer _to.Close()
	defer _from.Close()

	info_prefix := fmt.Sprintf("[%s] %s", cinfo.cid, cinfo.des)
	// 从 web 端读取数据，并转发到 devtools 端
	for {
		message, err := _from.ReadMessage()
		if err != nil {
			logger.Error(info_prefix + ": failed: " + err.Error())
			return
		}

		logger.Debug(fmt.Sprintf("%s: %s\n", info_prefix, message))

		is_ok := true // 为 true 表示继续转发
		if handler != nil {
			message, is_ok = (*handler)(_from, cinfo, message)
		}
		// 将数据转发到 devtools 端
		if is_ok {
			if err := _to.WriteMessage(message); err != nil {
				logger.Error(info_prefix + " failed: " + err.Error())
				return
			}
		}
	}
}

func handle_msg_from_devtools(_from *MyWSConnection, cinfo *ConnectionInfo, msg []byte) (data []byte, is_ok bool) {
	// easter egg ??? 嘿嘿
	if temp_msg := string(msg); strings.Contains(temp_msg, "Overlay.setPausedInDebuggerMessage") {
		msg = []byte(strings.Replace(temp_msg, "Paused in debugger", "Paused in debugger - Surprise "+Author, 1))
	}
	return msg, true
}

func handle_msg_from_web(_from *MyWSConnection, cinfo *ConnectionInfo, msg []byte) (data []byte, is_ok bool) {
	info_prefix := fmt.Sprintf("[%s] %s", cinfo.cid, "web -> server")

	// 忽略 id 为 0 的信息，那都是 cdp server 发出去的
	// 改进：不使用 JSON 处理，仅使用字符串匹配
	if strings.Contains(string(msg), `"id":0`) {
		logger.Debug(fmt.Sprintf("%s: (server drop id=0)", info_prefix))
		return nil, false
	}

	var cdp_res DebuggerPaused
	if err := json.Unmarshal(msg, &cdp_res); err == nil && cdp_res.Method == "Debugger.paused" {
		if process_debugger_paused(_from, cinfo, &cdp_res.Params) {
			logger.Debug(fmt.Sprintf("%s: (server ignore debugger paused): {%s}", info_prefix, msg))
			return nil, false
		}
	}

	return msg, true
}

// 处理断点信息。返回 true 表示进行了处理，不需要转发了；返回 false 表示需要转发
func process_debugger_paused(_from *MyWSConnection, cinfo *ConnectionInfo, params *DebuggerPausedParams) bool {
	// 是否为 debugger 语句
	is_js_debugger := (params.Reason == "other" && len(params.HitBreakpoints) == 0)
	if !is_js_debugger {
		return false
	}
	info_prefix := fmt.Sprintf("[%s] %s", cinfo.cid, "web -> server")
	// 是否为自定义的断点
	is_my_debugger := (params.CallFrames[0].FunctionName == MYDEBUGGER_NAME)
	if is_my_debugger {
		logger.Warn(fmt.Sprintf("[%s] debugger paused in my debugger {%s}", info_prefix, MYDEBUGGER_NAME))
		t := []byte(`{"id":0,"method":"Debugger.stepOut","params":{}}`)
		if err := _from.WriteMessage(t); err != nil {
			logger.Error("server send <Debugger.stepOut> message faild: " + err.Error())
			return false // 发送失败就转发好了
		}
		logger.Debug(fmt.Sprintf("%s: Debugger.stepOut", info_prefix))
		return true
	} else {
		// 不进行 JSON 处理，直接构建字符串发送
		t := []byte(`{"id":0,"method":"Debugger.resume","params":{"terminateOnResume":false}}`)
		if err := _from.WriteMessage(t); err != nil {
			logger.Error("server send <Debugger.resume> message faild: " + err.Error())
			return false // 发送失败就转发好了
		}
		logger.Debug(fmt.Sprintf("%s: Debugger.resume", info_prefix))
		return true
	}
}
