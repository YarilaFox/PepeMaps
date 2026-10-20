import React from "react"
import { createRoot } from "react-dom/client"
import PepeMapsSite from "./pepe-maps-site.jsx"
import "./styles.css"

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <PepeMapsSite />
  </React.StrictMode>
)
