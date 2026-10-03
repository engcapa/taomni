`termservice-public.der` is the public, self-signed RSA certificate exported from
GitHub Windows Server 2025 run [36962712369](https://github.com/engcapa/taomni/actions/runs/36962712369).
It contains no private key. SHA-256:
`f2577210f27be07e22fd3aa087a8514f35fe899f6de8fcbccb9a431f041b99aa`.

The offline TLS regression uses a fixed validation time and simulates a system
anchor with the same issuer name and another key. The exact pin must accept the
original certificate only after independently verifying its self-signature;
an absent pin or a damaged signature must still fail. TLS handshake signatures
remain verified by Rustls.
