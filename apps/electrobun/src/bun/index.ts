import { BrowserWindow } from "electrobun/main";

// Create the main application window
new BrowserWindow({
  title: "nanosync — Mock desktop demo",
  url: "views://mainview/index.html",
  frame: {
    width: 1280,
    height: 900,
    x: 200,
    y: 200,
  },
});
