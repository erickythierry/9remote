const savedTheme = localStorage.getItem("9remote-theme") || "dark";
document.documentElement.setAttribute("data-theme", savedTheme);
