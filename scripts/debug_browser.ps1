<#
.DESCRIPTION
启动浏览器的远程调试模式，可以选择 Edge、Chrome

.\debug_browser.ps1             # 默认打开 Chrome 浏览器，远程调试端口为 9222
.\debug_browser.ps1 -Port 8888  # 默认打开 Chrome 浏览器，远程调试端口为 8888

.\debug_browser.ps1 Edge               # 打开 Edge 浏览器，远程调试端口为 9222
.\debug_browser.ps1 Edge -Port 8888    # 打开 Edge 浏览器，远程调试端口为 8888
#>

[CmdletBinding()]
param (
    # 选择打开的浏览器
    [ValidateSet('Edge', 'Chrome')]
    [string]
    $Browser = 'Chrome',
    # 远程调试端口，即设置 remote-debugging-port
    [int]
    $Port = 9222,
    # 允许连接的来源，即设置 remote-allow-origin
    [string]
    $Origins = 'localhost'
)

# 对应浏览器的路径，根据需求进行修改
$Edge = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
$Chrome = "E:\Google\Chrome\Application\chrome.exe"

if (-not (Test-Path $Edge)) {
    Write-Error "Edge 浏览器路径错误，请检查是否存在: $Edge"
    exit
}
if (-not (Test-Path $Chrome)) {
    Write-Error "Chrome 浏览器路径错误，请检查是否存在: $Chrome"
    exit
}


if ($Browser -eq 'Edge') {
    Start-Process -FilePath $Edge -ArgumentList "--profile-directory=Default --remote-debugging-port=$Port --remote-allow-origins=$Origins"
}
else {
    Start-Process -FilePath $Chrome -ArgumentList "--remote-debugging-port=$Port --remote-allow-origins=$Origins"
}

Write-Host "$Browser 浏览器已启动，远程调试端口为 $Port"