import bs58 from "bs58";
import { stringify } from "safe-stable-stringify";
import { ed25519 } from "@noble/curves/ed25519";
import { Signature } from "./types.ts";


const encoder = new TextEncoder();
const decoder = new TextDecoder();

const cryptoProvider = typeof window !== "undefined" ? window.crypto : globalThis.crypto;

interface Keys {
    privateKey: string;
    publicKey: string;
}

const genKeys = (): Keys => {
    const privateKeyBuf = ed25519.utils.randomPrivateKey();
    const publicKeyBuf = ed25519.getPublicKey(privateKeyBuf);

    return {
        privateKey: bs58.encode(privateKeyBuf),
        publicKey: bs58.encode(publicKeyBuf),
    };
};

const getKeys = async (encryptedPrivateKey: string, password: string): Promise<Keys> => {
    const privateKey = await decrypt(encryptedPrivateKey, password);
    if (!privateKey) throw new Error("Failed to decrypt private key");
    const privateKeyBuf = bs58.decode(privateKey);
    const publicKeyBuf = ed25519.getPublicKey(privateKeyBuf);
    return {
        privateKey,
        publicKey: bs58.encode(publicKeyBuf),
    };
};

const sign = (key: string, data: string): string => {
    const privateKeyBuf = bs58.decode(key);
    const buf = encoder.encode(data);
    return bs58.encode(ed25519.sign(buf, privateKeyBuf));
};

const verify = (key: string, data: string, sig: string): boolean => {
    const publicKeyBuf = bs58.decode(key);
    const signature = bs58.decode(sig);
    const dataBuf = encoder.encode(data);
    return ed25519.verify(signature, dataBuf, publicKeyBuf);
};

const hash = async (obj: any): Promise<string> => {
    const data = stringify(obj);
    const buf = encoder.encode(data);
    const hashValue = await cryptoProvider.subtle.digest("SHA-256", buf);
    return bs58.encode(new Uint8Array(hashValue));
};

const checkSig = async (signature: Signature): Promise<boolean> => {
    if (!signature.sig) {
        return false;
    }
    const { sig, ...signatureCopy } = signature;
    const hashValue = await hash(signatureCopy);
    return await verify(signature.pubkey, hashValue, sig);
}

const buff_to_base64 = (buff: ArrayBuffer): string =>
    btoa(
        new Uint8Array(buff).reduce(
            (data, byte) => data + String.fromCharCode(byte),
            "",
        ),
    );

const base64_to_buf = (b64: string): Uint8Array =>
    Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

const getPasswordKey = (password: string): Promise<CryptoKey> =>
    cryptoProvider.subtle.importKey(
        "raw",
        encoder.encode(password),
        "PBKDF2",
        false,
        ["deriveKey"],
    );

const deriveKey = (passwordKey: CryptoKey, salt: Uint8Array, keyUsage: KeyUsage[]): Promise<CryptoKey> =>
    cryptoProvider.subtle.deriveKey(
        {
            name: "PBKDF2",
            salt: salt,
            iterations: 250000,
            hash: "SHA-256",
        },
        passwordKey,
        { name: "AES-GCM", length: 256 },
        false,
        keyUsage,
    );

const encrypt = async (secretData: string, password: string): Promise<string | undefined> => {
    try {
        const salt = cryptoProvider.getRandomValues(new Uint8Array(16));
        const iv = cryptoProvider.getRandomValues(new Uint8Array(12));
        const passwordKey = await getPasswordKey(password);
        const aesKey = await deriveKey(passwordKey, salt, ["encrypt"]);
        const encryptedContent = await cryptoProvider.subtle.encrypt(
            {
                name: "AES-GCM",
                iv: iv,
            },
            aesKey,
            encoder.encode(secretData),
        );

        const encryptedContentArr = new Uint8Array(encryptedContent);
        const buff = new Uint8Array(
            salt.byteLength + iv.byteLength + encryptedContentArr.byteLength,
        );
        buff.set(salt, 0);
        buff.set(iv, salt.byteLength);
        buff.set(encryptedContentArr, salt.byteLength + iv.byteLength);
        const base64Buff = buff_to_base64(buff);
        return base64Buff;
    } catch (_) {
        return undefined;
    }
};

const decrypt = async (encryptedData: string, password: string): Promise<string | undefined> => {
    try {
        const encryptedDataBuff = base64_to_buf(encryptedData);
        const salt = encryptedDataBuff.slice(0, 16);
        const iv = encryptedDataBuff.slice(16, 16 + 12);
        const data = encryptedDataBuff.slice(16 + 12);
        const passwordKey = await getPasswordKey(password);
        const aesKey = await deriveKey(passwordKey, salt, ["decrypt"]);
        const decryptedContent = await cryptoProvider.subtle.decrypt(
            {
                name: "AES-GCM",
                iv: iv,
            },
            aesKey,
            data,
        );
        return decoder.decode(decryptedContent);
    } catch (_) {
        return undefined;
    }
};

export {
    decrypt,
    encrypt,
    genKeys,
    getKeys,
    hash,
    sign,
    stringify,
    verify,
    checkSig,
};
