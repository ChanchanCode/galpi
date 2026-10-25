import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import "./styles.css";

const automaticDoc = new URLSearchParams(location.search).get("autoPdf");
if (automaticDoc) {
  window.galpiAutomaticPdf = import("./export/automaticPdf").then((worker) => worker.prepareAutomaticPdf(automaticDoc));
  // The main process awaits the original promise and reports any error on the library card.
  void window.galpiAutomaticPdf.catch(() => {});
} else ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
