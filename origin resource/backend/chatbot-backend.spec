# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller 打包配置：桌面版后端 chatbot-backend.exe

用法（在 backend 目录下）：
    pyinstaller --noconfirm chatbot-backend.spec

产物：dist/chatbot-backend.exe（onefile，console 子系统，由 Electron 主进程
以 `chatbot-backend.exe --port <port>` 方式启动并接管 stdout/stderr）。
"""

from PyInstaller.utils.hooks import collect_data_files, collect_dynamic_libs

hiddenimports = [
    # uvicorn 的实现模块大多是运行时按字符串加载的
    "uvicorn.logging",
    "uvicorn.loops",
    "uvicorn.loops.auto",
    "uvicorn.loops.asyncio",
    "uvicorn.protocols",
    "uvicorn.protocols.http",
    "uvicorn.protocols.http.auto",
    "uvicorn.protocols.http.h11_impl",
    "uvicorn.protocols.http.httptools_impl",
    "uvicorn.protocols.websockets",
    "uvicorn.protocols.websockets.auto",
    "uvicorn.protocols.websockets.websockets_impl",
    "uvicorn.protocols.websockets.wsproto_impl",
    "uvicorn.lifespan",
    "uvicorn.lifespan.on",
    "uvicorn.lifespan.off",
    "httptools",
    "watchfiles",
    "websockets",
    "websockets.legacy",
    "yaml",
    # 业务依赖
    "openai",
    "fitz",
    "pymupdf",
    "docx",
    # 表格与幻灯片解析（files.py 用来读 .xlsx / .pptx）
    "openpyxl",
    "pptx",
    "PIL",
    "PIL.Image",
    "PIL.ImageOps",
    "PIL.ImageDraw",
    # 图片导出（image_export.py）用到的编码器。PIL 的插件是运行时按需 import 的，
    # 静态分析看不到；pillow_heif 还带着 libheif 的二进制，必须显式带上。
    "PIL.TiffImagePlugin",
    "PIL.BmpImagePlugin",
    "PIL.GifImagePlugin",
    "PIL.IcoImagePlugin",
    "PIL.PdfImagePlugin",
    "PIL.WebPImagePlugin",
    "PIL.JpegImagePlugin",
    "PIL.PngImagePlugin",
    "pillow_heif",
    "image_export",
    "multipart",
    "python_multipart",
    "sqlite3",
    # 本项目自身的路由模块（routers/__init__ 已显式导入，这里再兜底一次）
    "logging_config",
    "model_probe",
    "routers",
    "routers.chat",
    "routers.code_exec",
    "routers.conversations",
    "routers.diagnostics",
    "routers.images",
    "routers.memories",
    "routers.migration",
    "routers.projects",
    "routers.settings",
    "routers.uploads",
    # runpy：--run-script 子进程入口用它跑用户代码，静态分析看不到这条路径。
    "runpy",
]

# python-pptx 会读自带的默认模板和一批 XML 资源，纯 hiddenimports 带不进来。
datas = collect_data_files("pptx")
# pillow-heif 的 libheif / aom 等动态库放在包目录里，同样得整包捞进来，
# 否则打出来的 exe 一导出 HEIC/AVIF 就报找不到编码器。
binaries = collect_dynamic_libs("pillow_heif")
datas += collect_data_files("pillow_heif")


a = Analysis(
    ["desktop_server.py"],
    pathex=["."],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=["tkinter", "pytest", "PyInstaller"],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name="chatbot-backend",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
