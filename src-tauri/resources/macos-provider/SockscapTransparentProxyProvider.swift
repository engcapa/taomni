// Sockscap macOS transparent-proxy provider (plan §4.1, §8; ADR-0003).
//
// This is the NETransparentProxyProvider that runs inside a Network Extension
// *system extension*. It must be built as a separate Xcode target embedded in
// the Taomni .app, signed with a Developer ID, granted the
// `com.apple.developer.networking.networkextension` entitlement
// (`app-proxy-provider-systemextension`), and notarized — none of which can be
// produced by the Rust cargo build. That packaging is the external step; this
// file is the provider's actual source.
//
// Design: the provider decides, per flow, whether the source app is in the
// user-selected set (by code-signing identity / audit token). Handled flows are
// relayed to the local Sockscap SOCKS5 capture port (the same backend the Rust
// engine already runs), so all routing/policy stays in one place. Unselected
// apps are passed through (DIRECT). This mirrors
// `transparent::macos_provider_decision` on the Rust side.

import NetworkExtension
import Network
import os.log

/// The local SOCKS5 port the Rust engine's capture backend listens on.
private let sockscapSocksPort: UInt16 = 1080

final class SockscapTransparentProxyProvider: NETransparentProxyProvider {
    private let log = OSLog(subsystem: "com.taomni.app.sockscap", category: "provider")

    /// Signing identities (Team ID + bundle id) the user selected to route.
    /// Delivered via the provider configuration; empty means "global".
    private var selectedAppIDs: Set<String> = []

    override func startProxy(options: [String: Any]? = nil, completionHandler: @escaping (Error?) -> Void) {
        if let ids = options?["selectedAppIDs"] as? [String] {
            selectedAppIDs = Set(ids)
        }
        // Include-all rule; per-flow filtering happens in handleNewFlow.
        let settings = NETransparentProxyNetworkSettings(tunnelRemoteAddress: "127.0.0.1")
        let tcp = NENetworkRule(
            remoteNetwork: nil,
            remotePrefix: 0,
            localNetwork: nil,
            localPrefix: 0,
            protocol: .TCP,
            direction: .outbound
        )
        settings.includedNetworkRules = [tcp]
        setTunnelNetworkSettings(settings) { error in
            if let error = error {
                os_log("failed to set settings: %{public}@", log: self.log, type: .error, "\(error)")
            }
            completionHandler(error)
        }
    }

    override func stopProxy(with reason: NEProviderStopReason, completionHandler: @escaping () -> Void) {
        completionHandler()
    }

    /// Decide + handle each new flow. Selected apps are relayed through the
    /// local Sockscap SOCKS5 backend; everyone else passes through (DIRECT).
    override func handleNewFlow(_ flow: NEAppProxyFlow) -> Bool {
        let signingID = flow.metaData.sourceAppSigningIdentifier
        let shouldHandle = selectedAppIDs.isEmpty || selectedAppIDs.contains(signingID)
        guard shouldHandle, let tcpFlow = flow as? NEAppProxyTCPFlow else {
            return false // pass through (DIRECT)
        }
        guard let endpoint = tcpFlow.remoteEndpoint as? NWHostEndpoint else {
            return false
        }
        relayThroughSocks(tcpFlow, host: endpoint.hostname, port: endpoint.port)
        return true
    }

    /// Open the flow, connect to the local SOCKS5 port, perform a CONNECT to the
    /// original destination, and pump bytes both ways. Routing/policy is decided
    /// by the Rust engine behind that SOCKS port.
    private func relayThroughSocks(_ flow: NEAppProxyTCPFlow, host: String, port: String) {
        let conn = NWConnection(
            host: .ipv4(.loopback),
            port: NWEndpoint.Port(rawValue: sockscapSocksPort)!,
            using: .tcp
        )
        conn.stateUpdateHandler = { [weak self] state in
            guard let self = self else { return }
            switch state {
            case .ready:
                flow.open(withLocalEndpoint: nil) { error in
                    if error == nil {
                        self.socksHandshake(conn, host: host, port: UInt16(port) ?? 0) {
                            self.pump(flow: flow, conn: conn)
                        }
                    } else {
                        conn.cancel()
                    }
                }
            case .failed, .cancelled:
                flow.closeReadWithError(nil)
                flow.closeWriteWithError(nil)
            default:
                break
            }
        }
        conn.start(queue: .global())
    }

    /// Minimal SOCKS5 CONNECT handshake to the local backend (no auth).
    private func socksHandshake(_ conn: NWConnection, host: String, port: UInt16, done: @escaping () -> Void) {
        let greeting = Data([0x05, 0x01, 0x00])
        conn.send(content: greeting, completion: .contentProcessed { _ in
            conn.receive(minimumIncompleteLength: 2, maximumLength: 2) { _, _, _, _ in
                var req: [UInt8] = [0x05, 0x01, 0x00, 0x03, UInt8(host.utf8.count)]
                req.append(contentsOf: Array(host.utf8))
                req.append(UInt8(port >> 8))
                req.append(UInt8(port & 0xff))
                conn.send(content: Data(req), completion: .contentProcessed { _ in
                    conn.receive(minimumIncompleteLength: 10, maximumLength: 10) { _, _, _, _ in
                        done()
                    }
                })
            }
        })
    }

    /// Bidirectionally pump bytes between the app flow and the SOCKS connection.
    private func pump(flow: NEAppProxyTCPFlow, conn: NWConnection) {
        func appToProxy() {
            flow.readData { data, error in
                guard let data = data, !data.isEmpty, error == nil else {
                    conn.cancel()
                    return
                }
                conn.send(content: data, completion: .contentProcessed { _ in appToProxy() })
            }
        }
        func proxyToApp() {
            conn.receive(minimumIncompleteLength: 1, maximumLength: 65536) { data, _, isComplete, error in
                if let data = data, !data.isEmpty {
                    flow.write(data) { _ in proxyToApp() }
                } else if isComplete || error != nil {
                    flow.closeReadWithError(nil)
                    flow.closeWriteWithError(nil)
                }
            }
        }
        appToProxy()
        proxyToApp()
    }
}
