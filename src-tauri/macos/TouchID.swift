// Touch ID quick unlock for macOS (quick_unlock.rs). Built into a static
// library by build.rs and called from Rust through the C functions below.
//
// The vault key is sealed to a P-256 key made in this Mac's Secure Enclave.
// That key never leaves the enclave: what's kept is an opaque blob only this
// enclave can turn back into it, and it only agrees on a secret right after
// a Touch ID check with the fingers enrolled now (a finger added or removed
// later makes it useless). Nothing goes into the keychain, so the app needs
// no keychain entitlement and works unsigned.
//
// Sealing: an ephemeral P-256 key agrees with the enclave key's public half,
// HKDF-SHA256 turns that into an AES-256-GCM key that seals the vault key.
// Opening redoes the agreement with the enclave key, after Touch ID.

import CryptoKit
import Foundation
import LocalAuthentication

private let OK: Int32 = 0
private let CANCELLED: Int32 = 1
private let STALE: Int32 = 2
private let UNAVAILABLE: Int32 = 3

private let info = Data("supermarine quick unlock macos v1".utf8)

private func put(_ data: Data, _ out: UnsafeMutablePointer<UInt8>, _ cap: Int, _ len: UnsafeMutablePointer<Int>) -> Bool {
    guard data.count <= cap else { return false }
    data.copyBytes(to: out, count: data.count)
    len.pointee = data.count
    return true
}

private func say(_ text: String, _ out: UnsafeMutablePointer<UInt8>, _ cap: Int) {
    let bytes = Array(text.utf8.prefix(cap - 1))
    bytes.withUnsafeBufferPointer { out.update(from: $0.baseAddress!, count: bytes.count) }
    out[bytes.count] = 0
}

private func wrappingKey(_ secret: SharedSecret, _ peer: Data) -> SymmetricKey {
    secret.hkdfDerivedSymmetricKey(using: SHA256.self, salt: peer, sharedInfo: info, outputByteCount: 32)
}

/// Asks for Touch ID and gives back the checked context, or a code.
private func authenticate(_ reason: String) -> (LAContext?, Int32, String) {
    let ctx = LAContext()
    ctx.localizedFallbackTitle = "Use Password"
    var canErr: NSError?
    guard ctx.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &canErr) else {
        return (nil, UNAVAILABLE, canErr?.localizedDescription ?? "Touch ID isn't available")
    }
    let done = DispatchSemaphore(value: 0)
    var result: (Bool, Error?) = (false, nil)
    ctx.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: reason) { ok, err in
        result = (ok, err)
        done.signal()
    }
    done.wait()
    if result.0 { return (ctx, OK, "") }
    if let la = result.1 as? LAError {
        switch la.code {
        case .userCancel, .userFallback, .systemCancel, .appCancel:
            return (nil, CANCELLED, "")
        default:
            return (nil, UNAVAILABLE, la.localizedDescription)
        }
    }
    return (nil, UNAVAILABLE, result.1?.localizedDescription ?? "Touch ID failed")
}

/// 1 when this Mac has a Secure Enclave and an enrolled finger.
@_cdecl("sm_touchid_ready")
public func sm_touchid_ready() -> Int32 {
    guard SecureEnclave.isAvailable else { return 0 }
    var err: NSError?
    return LAContext().canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &err) ? 1 : 0
}

/// Seals `key` (32 bytes) to a new enclave key. Asks for Touch ID once and
/// opens what it sealed, so it's known to work before anything is saved.
@_cdecl("sm_touchid_seal")
public func sm_touchid_seal(
    _ reasonPtr: UnsafePointer<CChar>,
    _ key: UnsafePointer<UInt8>,
    _ blobOut: UnsafeMutablePointer<UInt8>, _ blobCap: Int, _ blobLen: UnsafeMutablePointer<Int>,
    _ peerOut: UnsafeMutablePointer<UInt8>, _ peerCap: Int, _ peerLen: UnsafeMutablePointer<Int>,
    _ boxOut: UnsafeMutablePointer<UInt8>, _ boxCap: Int, _ boxLen: UnsafeMutablePointer<Int>,
    _ msg: UnsafeMutablePointer<UInt8>, _ msgCap: Int
) -> Int32 {
    guard SecureEnclave.isAvailable else {
        say("this Mac has no Secure Enclave", msg, msgCap)
        return UNAVAILABLE
    }
    let (ctx, code, why) = authenticate(String(cString: reasonPtr))
    guard let ctx else {
        say(why, msg, msgCap)
        return code
    }
    do {
        guard let access = SecAccessControlCreateWithFlags(
            nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly, [.privateKeyUsage, .biometryCurrentSet], nil
        ) else {
            say("the access rule couldn't be made", msg, msgCap)
            return UNAVAILABLE
        }
        let enclaveKey = try SecureEnclave.P256.KeyAgreement.PrivateKey(accessControl: access, authenticationContext: ctx)
        let ephemeral = P256.KeyAgreement.PrivateKey()
        let peer = ephemeral.publicKey.x963Representation
        let wrap = wrappingKey(try ephemeral.sharedSecretFromKeyAgreement(with: enclaveKey.publicKey), peer)
        var plain = Data(bytes: key, count: 32)
        defer { plain.resetBytes(in: 0..<plain.count) }
        guard let box = try AES.GCM.seal(plain, using: wrap).combined else {
            say("sealing failed", msg, msgCap)
            return UNAVAILABLE
        }
        var check = try AES.GCM.open(
            AES.GCM.SealedBox(combined: box),
            using: wrappingKey(try enclaveKey.sharedSecretFromKeyAgreement(with: ephemeral.publicKey), peer)
        )
        defer { check.resetBytes(in: 0..<check.count) }
        guard check == plain else {
            say("the sealed key didn't open again", msg, msgCap)
            return UNAVAILABLE
        }
        guard put(enclaveKey.dataRepresentation, blobOut, blobCap, blobLen),
              put(peer, peerOut, peerCap, peerLen),
              put(box, boxOut, boxCap, boxLen) else {
            say("output too large", msg, msgCap)
            return UNAVAILABLE
        }
        return OK
    } catch {
        say(error.localizedDescription, msg, msgCap)
        return UNAVAILABLE
    }
}

/// Opens what `sm_touchid_seal` made, after Touch ID, into `keyOut` (32 bytes).
@_cdecl("sm_touchid_open")
public func sm_touchid_open(
    _ reasonPtr: UnsafePointer<CChar>,
    _ blob: UnsafePointer<UInt8>, _ blobLen: Int,
    _ peer: UnsafePointer<UInt8>, _ peerLen: Int,
    _ box: UnsafePointer<UInt8>, _ boxLen: Int,
    _ keyOut: UnsafeMutablePointer<UInt8>,
    _ msg: UnsafeMutablePointer<UInt8>, _ msgCap: Int
) -> Int32 {
    guard SecureEnclave.isAvailable else {
        say("this Mac has no Secure Enclave", msg, msgCap)
        return UNAVAILABLE
    }
    let (ctx, code, why) = authenticate(String(cString: reasonPtr))
    guard let ctx else {
        say(why, msg, msgCap)
        return code
    }
    // From here every failure means the sealed key no longer opens here:
    // another Mac's blob, or the enrolled fingers changed since.
    do {
        let peerData = Data(bytes: peer, count: peerLen)
        let enclaveKey = try SecureEnclave.P256.KeyAgreement.PrivateKey(
            dataRepresentation: Data(bytes: blob, count: blobLen), authenticationContext: ctx
        )
        let ephemeral = try P256.KeyAgreement.PublicKey(x963Representation: peerData)
        let wrap = wrappingKey(try enclaveKey.sharedSecretFromKeyAgreement(with: ephemeral), peerData)
        var plain = try AES.GCM.open(AES.GCM.SealedBox(combined: Data(bytes: box, count: boxLen)), using: wrap)
        defer { plain.resetBytes(in: 0..<plain.count) }
        guard plain.count == 32 else { return STALE }
        plain.copyBytes(to: keyOut, count: 32)
        return OK
    } catch {
        say(error.localizedDescription, msg, msgCap)
        return STALE
    }
}
