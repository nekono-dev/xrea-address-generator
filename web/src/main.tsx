import { render } from "preact"
import { App } from "./App"
import { registerServiceWorker } from "./pwa"
import "./styles.css"

render(<App />, document.getElementById("app")!)
registerServiceWorker()
