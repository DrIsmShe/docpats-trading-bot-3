import mongoose from "mongoose";

let isConnected = false;

/**
 * Подключение к MongoDB.
 *
 * Singleton — подключается один раз, повторные вызовы возвращают существующее соединение.
 * Это важно: если каждый модуль будет звать connect() — будет 10 параллельных соединений.
 */
export async function connectMongo(uri) {
  if (isConnected) {
    return mongoose.connection;
  }

  if (!uri) {
    throw new Error("connectMongo: MONGO_URI не задан");
  }

  try {
    await mongoose.connect(uri, {
      // Современные дефолты Mongoose 7+
      serverSelectionTimeoutMS: 10000,
    });
    isConnected = true;
    console.log("✅ MongoDB подключён");
    return mongoose.connection;
  } catch (err) {
    console.error("❌ MongoDB connection error:", err.message);
    throw err;
  }
}

/**
 * Закрыть соединение. Используется в скриптах после завершения работы.
 */
export async function disconnectMongo() {
  if (isConnected) {
    await mongoose.disconnect();
    isConnected = false;
    console.log("🔌 MongoDB отключён");
  }
}
