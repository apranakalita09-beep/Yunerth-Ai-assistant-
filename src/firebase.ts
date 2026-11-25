import { initializeApp } from "firebase/app";
import { GoogleAuthProvider, getAuth } from "firebase/auth";
import { doc, getDocFromServer, getFirestore } from "firebase/firestore";
import firebaseConfig from "../firebase-applet-config.json";

const app = initializeApp(firebaseConfig);

export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: "select_account" });

let connectionCheckPromise: Promise<boolean> | null = null;

export function testFirestoreConnection(): Promise<boolean> {
  if (connectionCheckPromise) {
    return connectionCheckPromise;
  }
  connectionCheckPromise = (async () => {
    try {
      await getDocFromServer(doc(db, "test", "connection"));
      return true;
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes("the client is offline")
      ) {
        console.error(
          "Please check your Firebase configuration: Firestore client is offline."
        );
        return false;
      }
      // Permission denied on /test/connection still proves server reachability
      return true;
    } finally {
      connectionCheckPromise = null;
    }
  })();
  return connectionCheckPromise;
}
