import init, * as bindings from './chat-sidebar-836101f3affe2025.js';
const wasm = await init({ module_or_path: './chat-sidebar-836101f3affe2025_bg.wasm' });


window.wasmBindings = bindings;


dispatchEvent(new CustomEvent("TrunkApplicationStarted", {detail: {wasm}}));