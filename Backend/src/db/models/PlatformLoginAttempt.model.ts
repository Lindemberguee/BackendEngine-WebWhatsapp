import { Schema, model } from 'mongoose';

const schema = new Schema({
  _id: { type: String, required: true },
  attempts: { type: Number, required: true },
  windowEndsAt: { type: Date, required: true },
}, { versionKey: false });

schema.index({ windowEndsAt: 1 }, { expireAfterSeconds: 0 });
export const PlatformLoginAttempt = model('PlatformLoginAttempt', schema);
