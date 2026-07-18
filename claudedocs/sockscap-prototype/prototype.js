(() => {
  const bySelector = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  const toast = document.querySelector("[data-toast]");
  let toastTimer;
  const showToast = (message) => {
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add("show");
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toast.classList.remove("show"), 2400);
  };

  const currentFile = window.location.pathname.split("/").pop() || "index.html";
  bySelector("[data-nav]").forEach((link) => {
    const href = link.getAttribute("href") || "";
    if (href === currentFile || (currentFile === "" && href === "index.html")) {
      link.setAttribute("aria-current", "page");
    }
  });

  const engineButton = document.querySelector("[data-engine-toggle]");
  const engineLabel = document.querySelector("[data-engine-label]");
  const engineSubtext = document.querySelector("[data-engine-subtext]");
  if (engineButton) {
    engineButton.addEventListener("click", () => {
      const running = document.body.dataset.engineState !== "off";
      document.body.dataset.engineState = running ? "off" : "active";
      engineButton.textContent = running ? "启动路由" : "停止路由";
      engineButton.classList.toggle("danger", !running);
      engineButton.classList.toggle("primary", running);
      if (engineLabel) engineLabel.textContent = running ? "已停止" : "运行中";
      if (engineSubtext) {
        engineSubtext.textContent = running
          ? "捕获面已撤销，系统恢复直连"
          : "3 个配置组 · SSH Jump HK-Bastion";
      }
      showToast(running ? "原型演示：已执行 fail-open 停止与网络恢复" : "原型演示：预检通过，Sockscap 已启动");
    });
  }

  bySelector("[data-show-toast]").forEach((button) => {
    button.addEventListener("click", () => showToast(button.dataset.showToast || "操作已完成"));
  });

  bySelector("[data-segment]").forEach((segment) => {
    bySelector("button", segment).forEach((button) => {
      button.addEventListener("click", () => {
        bySelector("button", segment).forEach((item) => item.classList.remove("active"));
        button.classList.add("active");
        showToast(`原型演示：已切换为“${button.textContent.trim()}”`);
      });
    });
  });

  bySelector("[data-profile-item]").forEach((button) => {
    button.addEventListener("click", () => {
      bySelector("[data-profile-item]").forEach((item) => item.classList.remove("active"));
      button.classList.add("active");
      const title = document.querySelector("[data-profile-title]");
      if (title && button.dataset.profileTitle) title.textContent = button.dataset.profileTitle;
      showToast(`已选择配置组：${button.dataset.profileTitle || button.textContent.trim()}`);
    });
  });

  const egressKind = document.querySelector("[data-egress-kind]");
  const syncEgressPanels = () => {
    if (!egressKind) return;
    bySelector("[data-egress-panel]").forEach((panel) => {
      panel.hidden = panel.dataset.egressPanel !== egressKind.value;
    });
  };
  if (egressKind) {
    egressKind.addEventListener("change", () => {
      syncEgressPanels();
      showToast(egressKind.value === "ssh" ? "已切换为 SSH 跳板出站" : "已切换为 Proxy Session 出站");
    });
    syncEgressPanels();
  }

  const testEgressButton = document.querySelector("[data-test-egress]");
  if (testEgressButton) {
    testEgressButton.addEventListener("click", () => {
      const original = testEgressButton.textContent;
      testEgressButton.disabled = true;
      testEgressButton.textContent = "验证 host key 与 channel…";
      window.setTimeout(() => {
        testEgressButton.disabled = false;
        testEgressButton.textContent = original;
        const result = document.querySelector("[data-egress-test-result]");
        if (result) {
          result.innerHTML = "<strong>测试通过</strong><span>Host key 已匹配 · SSH 42 ms · direct-tcpip 目标 96 ms · Remote DNS</span>";
          result.classList.remove("warn");
        }
        showToast("SSH 跳板测试通过；UDP 仍按 BLOCK 策略处理");
      }, 760);
    });
  }

  const architectureButtons = bySelector("[data-platform]");
  const architectureDetail = document.querySelector("[data-platform-detail]");
  const platformDetails = {
    windows: {
      title: "Windows 捕获候选",
      body: "Global：Wintun/TUN。程序/PID：Phase 0 对照 WinDivert SOCKET/FLOW/NETWORK 动态过滤与 WFP ALE redirect，经过许可证、签名、EDR/VPN 和回注正确性 ADR 后定案。",
    },
    macos: {
      title: "macOS 捕获候选",
      body: "NETransparentProxyProvider 使用 sourceAppAuditToken 与 signing identifier；Rust 与 provider 之间采用版本化、认证的控制协议，并保留恢复心跳。",
    },
    linux: {
      title: "Linux 捕获候选",
      body: "既有进程：cgroup v2 + nft socket cgroup + fwmark policy route。由 Taomni 启动：user/network namespace；能力不足时明确降级。",
    },
  };
  architectureButtons.forEach((button) => {
    button.addEventListener("click", () => {
      architectureButtons.forEach((item) => item.classList.remove("active"));
      button.classList.add("active");
      const detail = platformDetails[button.dataset.platform];
      if (architectureDetail && detail) {
        architectureDetail.innerHTML = `<strong>${detail.title}</strong><span>${detail.body}</span>`;
      }
    });
  });

  const refreshRules = document.querySelector("[data-refresh-rules]");
  if (refreshRules) {
    refreshRules.addEventListener("click", () => {
      const original = refreshRules.textContent;
      refreshRules.disabled = true;
      refreshRules.textContent = "下载并原子校验…";
      window.setTimeout(() => {
        refreshRules.disabled = false;
        refreshRules.textContent = original;
        const syncTime = document.querySelector("[data-rule-sync-time]");
        if (syncTime) syncTime.textContent = "刚刚 · GitLab · SHA-256 91a8…e2c1";
        showToast("规则源刷新成功，已原子替换 matcher snapshot");
      }, 720);
    });
  }

  const runRuleTest = document.querySelector("[data-run-rule-test]");
  if (runRuleTest) {
    runRuleTest.addEventListener("click", () => {
      const application = document.querySelector("[data-test-app]")?.value || "Chrome.exe";
      const target = document.querySelector("[data-test-target]")?.value.trim() || "youtube.com";
      const appText = document.querySelector("[data-decision-app]");
      const hostText = document.querySelector("[data-decision-host]");
      const finalText = document.querySelector("[data-decision-final]");
      if (appText) appText.textContent = `${application} → Browsers / GFWList`;
      if (hostText) hostText.textContent = `${target} · system DNS · confidence high`;
      if (finalText) finalText.textContent = `PROXY via SSH HK-Bastion · direct-tcpip ${target}:443`;
      showToast(`已解释 ${application} → ${target} 的最终路由决策`);
    });
  }

  const hideButton = document.querySelector("[data-hide-window]");
  if (hideButton) {
    hideButton.addEventListener("click", () => showToast("原型演示：窗口将隐藏到系统托盘，路由保持运行"));
  }
})();
