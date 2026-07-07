import init, * as bindings from './chat-sidebar-692e6e22b716bf83.js';
const wasm = await init({ module_or_path: './chat-sidebar-692e6e22b716bf83_bg.wasm' });


window.wasmBindings = bindings;


dispatchEvent(new CustomEvent("TrunkApplicationStarted", {detail: {wasm}}));