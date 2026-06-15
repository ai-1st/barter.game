// This is bundled into a single file with browserify using the following command:
// tsc && browserify dist/server.js --standalone tips -o dist/tips.bundle.js && cp dist/tips.bundle.js ../frontend-bulma/

import { ulid } from 'ulid';
import { decrypt, encrypt, genKeys, getKeys, hash, sign, verify } from './tips';

const serverUrl = (window.location.origin === "file://" || window.location.hostname === "127.0.0.1")
    ? "http://localhost:8001"
    : window.location.origin;

async function post(url: string, data: any): Promise<any> {
    const response = await fetch(`${serverUrl}${url}`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify(data),
    });
    if (!response.ok) {
        throw new Error(await response.text());
    }
    return await response.json();
}

async function postOther(url: string, data: any): Promise<any> {
    const response = await fetch(`${url}`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify(data),
    });
    if (!response.ok) {
        throw new Error(await response.text());
    }
    return await response.json();
}

async function swap(ulid: string, contactCard: any): Promise<any> {
    return await post(`/swap/${ulid}`, contactCard);
}

async function get(url: string): Promise<any> {
    console.log("Get", `${serverUrl}${url}`);
    const response = await fetch(`${serverUrl}${url}`);
    if (!response.ok) {
        console.log("Error", await response.text());
        throw new Error(await response.text());
    }
    const data = await response.json();
    console.log("Got", data);
    return data;
}

async function signIn(login: string, password: string): Promise<{ profile: any, keys: any }> {
    console.log("Sign in", login, password);
    const passwordHash = await hash(login + password);
    const profile = await post(`/homebase/signin`, {
        login,
        passwordHash,
    });
    profile.type = "profile";
    const keys = await getKeys(profile.encryptedPrivateKey, password);

    if (!profile.contacts) {
        console.log("No contacts");
        profile.contacts = [];
    } else {
        console.log("contacts present", profile.contacts);
    }

    // if (!profile.contactCard) {
    //     profile.contactCard = await buildContactCard(
    //         "TODO",
    //         "TODO ledger url",
    //         {},
    //         keys.publicKey
    //     );
    // }
    profile.ulid = ulid();
    profile.sigs = [];
    const signedProfile = await signDoc(profile, {}, keys.privateKey, keys.publicKey);
    await saveItem(signedProfile);

    return { profile: signedProfile, keys };
}

async function signUp(login: string, password: string): Promise<any> {
    console.log("Starting signUp process for login:", login);
    const keys = genKeys();
    console.log("Generated keys:", keys);
    const encryptedPrivateKey = await encrypt(keys.privateKey, password);
    console.log("Encrypted private key:", encryptedPrivateKey);
    const passwordHash = await hash(login + password);
    console.log("Generated password hash:", passwordHash);
    const contactDocVoucher = await buildContactDoc(
        "TODO ledger pubkey",
        keys.privateKey,
        keys.publicKey
    );
    console.log("Contact doc voucher:", contactDocVoucher);

    const doc = {
        type: "profile",
        ulid: ulid(),
        login,
        passwordHash,
        pubkey: keys.publicKey,
        encryptedPrivateKey,
        contacts: []
    };
    console.log("Created profile document:", doc);
    const signedDoc = await signDoc(doc, {}, keys.privateKey, keys.publicKey);
    console.log("Signed document:", signedDoc);
    const signupVoucher = post(`/homebase/signup`, signedDoc);
    console.log("Signup voucher:", signupVoucher);
    await Promise.all([signupVoucher, contactDocVoucher]);
    console.log("Signup process completed successfully");
    return true;
}

async function buildContactDoc(ledger: string, privateKey: string, publicKey: string): Promise<any> {
    const contactDoc = {
        type: "contact",
        pubkey: publicKey,
        ulid: ulid(),
        url: serverUrl + "/public/",
        ledger,
    };
    const signed = await signDoc(contactDoc, { action: "approve" }, privateKey, publicKey);
    await post("/directory", signed);
    localStorage.setItem("contact/" + publicKey, JSON.stringify(signed));
    return signed;
}

async function latestSig(publicKey: string): Promise<any> {
    try {
        return (await get(`/public/${publicKey}/chain/latest`)).value;
    } catch (e) {
        console.log("No latestSig found");
        return false;
    }
}

async function signDoc(obj: any, sigProto: any, privateKey: string, publicKey: string): Promise<any> {
    const { sigs: _, ...unsigned } = obj;
    const docHash = await hash(unsigned);
    const signature = {
        ...sigProto,
        hash: docHash,
        ulid: ulid(),
        pubkey: publicKey,
    };
    const sigHash = await hash(signature);
    signature.sig = sign(privateKey, sigHash);

    return {
        ...obj,
        sigs: Array.isArray(obj.sigs)
            ? [...obj.sigs, signature]
            : [signature],
    };
}

async function send1USD(pubkey: string, senderPublicKey: string): Promise<any> {
    const trade = {
        pubkey: senderPublicKey,
        ulid: ulid(),
        type: "trade",
        maxAge: 60,
    };
    return trade;
}

async function saveItem(item: any): Promise<any> {
    return await post("/homebase/store", item);
}

async function createBlock(data: any): Promise<any> {
    // Implement createBlock logic here
    // This is a placeholder implementation
    return { blockId: ulid(), data };
}

export {
    serverUrl,
    post,
    postOther,
    swap,
    get,
    signIn,
    signUp,
    buildContactDoc,
    latestSig,
    signDoc,
    send1USD,
    saveItem,
    createBlock,
    sign,
    verify,
    genKeys
};