export function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) {
    return;
  }

  if (window.location.protocol === "file:") {
    return;
  }

  window.addEventListener("load", () => {
    const hadController = Boolean(navigator.serviceWorker.controller);
    let reloadingForUpdate = false;

    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (!hadController || reloadingForUpdate) return;
      reloadingForUpdate = true;
      window.location.reload();
    });

    navigator.serviceWorker
      .register("./sw.js")
      .then((registration) => registration.update())
      .catch((error) => {
        console.warn("Service worker registration failed", error);
      });
  });
}
