import axios from "axios";

export default async ({ req, res, log, error }) => {
  try {
    const { order_id } = JSON.parse(req.body || "{}");

    if (!order_id) {
      return res.json({
        success: false,
        error: "order_id is required",
        code: "VALIDATION_ERROR"
      }, 400);
    }

    log("Verifying Cashfree order", { order_id });

    const response = await axios.get(
      "https://sandbox.cashfree.com/pg/orders/${order_id}",
      {
        headers: {
          "x-client-id": process.env.CASHFREE_CLIENT_ID,
          "x-client-secret": process.env.CASHFREE_CLIENT_SECRET,
          "x-api-version": "2022-09-01"
        }
      }
    );

    const data = response.data;

    const isPaid = data.order_status === "PAID";

    log("Verification result", { order_id, status: data.order_status });

    return res.json({
      success: true,
      paid: isPaid,
      order_status: data.order_status,
      data: data
    }, 200);

  } catch (err) {
    error("Cashfree verification failed", err);

    return res.json({
      success: false,
      error: err.response?.data?.message || err.message,
      code: "CASHFREE_VERIFY_FAILED"
    }, 500);
  }
};
