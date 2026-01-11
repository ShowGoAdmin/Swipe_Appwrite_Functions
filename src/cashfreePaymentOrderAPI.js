import axios from "axios";
import { Client } from "node-appwrite";

export default async ({ req, res, log, error }) => {
  try {
    const {
      amount,
      customer_id,
      customer_email,
      customer_phone,
      customer_name
    } = JSON.parse(req.body || "{}");

    if (!amount || !customer_email || !customer_phone) {
      return res.json({
        success: false,
        error: "Missing required fields",
        code: "VALIDATION_ERROR"
      }, 400);
    }


    const payload = {
      order_amount: amount.toString(),
      order_currency: "INR",
      customer_details: {
        customer_id: customer_id || "",
        customer_name: customer_name || "",
        customer_email: customer_email,
        customer_phone: customer_phone
      }
    };

    log("Creating Cashfree order", payload);

    const response = await axios.post(
      "https://sandbox.cashfree.com/pg/orders",
      payload,
      {
        headers: {
          "x-client-id": process.env.CASHFREE_CLIENT_ID,
          "x-client-secret": process.env.CASHFREE_CLIENT_SECRET,
          "x-api-version": "2022-09-01",
          "Content-Type": "application/json"
        }
      }
    );

    const data = response.data;

    log("Cashfree order created", data);

    return res.json({
      success: true,
      order_id: data.order_id,
      payment_session_id: data.payment_session_id
    }, 200);

  } catch (err) {
    error("Cashfree order creation failed", err);

    return res.json({
      success: false,
      error: err.response?.data?.message || err.message,
      code: "CASHFREE_ORDER_FAILED"
    }, 500);
  }
};
