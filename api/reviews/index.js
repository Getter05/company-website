const { TableClient, AzureNamedKeyCredential } = require("@azure/data-tables");

const tableName = "Reviews";

function getClient() {
  const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;

  if (!connectionString) {
    throw new Error("Missing AZURE_STORAGE_CONNECTION_STRING");
  }

  return TableClient.fromConnectionString(connectionString, tableName);
}

function cleanText(value, maxLength) {
  return String(value || "")
    .trim()
    .replace(/[<>]/g, "")
    .slice(0, maxLength);
}

async function sendDiscordReviewNotification(reviewEntity) {
  const webhookUrl = process.env.DISCORD_REVIEW_WEBHOOK_URL;

  if (!webhookUrl) {
    return;
  }

  const stars = "★".repeat(Number(reviewEntity.rating)) + "☆".repeat(5 - Number(reviewEntity.rating));

  const message = {
    embeds: [
      {
        title: "New Website Review Submitted",
        color: 0xF97316,
        fields: [
          {
            name: "Name",
            value: reviewEntity.name || "Not provided",
            inline: true
          },
          {
            name: "Business",
            value: reviewEntity.business || "Not provided",
            inline: true
          },
          {
            name: "Rating",
            value: stars,
            inline: false
          },
          {
            name: "Review",
            value: reviewEntity.review || "No review text",
            inline: false
          },
          {
            name: "Approval Status",
            value: "Not approved yet. Go to Azure Table Storage and set `approved` to `true`.",
            inline: false
          },
          {
            name: "RowKey",
            value: reviewEntity.rowKey,
            inline: false
          }
        ],
        timestamp: reviewEntity.createdAt
      }
    ]
  };

  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(message)
  });

  if (!response.ok) {
    throw new Error(`Discord webhook failed with status ${response.status}`);
  }
}

module.exports = async function (context, req) {
  const client = getClient();

  if (req.method === "GET") {
    const approvedReviews = [];

    for await (const review of client.listEntities({
      queryOptions: {
        filter: "PartitionKey eq 'review' and approved eq true"
      }
    })) {
      approvedReviews.push({
        name: review.name,
        business: review.business || "",
        rating: review.rating,
        review: review.review,
        createdAt: review.createdAt
      });
    }

    approvedReviews.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    context.res = {
      status: 200,
      headers: {
        "Content-Type": "application/json"
      },
      body: approvedReviews
    };

    return;
  }

  if (req.method === "POST") {
    const body = req.body || {};

    const name = cleanText(body.name, 80);
    const business = cleanText(body.business, 100);
    const review = cleanText(body.review, 1000);
    const rating = Number(body.rating);
    const permission = body.permission === true || body.permission === "true" || body.permission === "Yes";

    if (!name || !review || !permission || !Number.isInteger(rating) || rating < 1 || rating > 5) {
      context.res = {
        status: 400,
        body: {
          error: "Missing required review information."
        }
      };
      return;
    }

    const entity = {
      partitionKey: "review",
      rowKey: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      name,
      business,
      rating,
      review,
      permission,
      approved: false,
      createdAt: new Date().toISOString()
    };

    await client.createEntity(entity);

    try {
      await sendDiscordReviewNotification(entity);
    } catch (notificationError) {
      context.log("Discord notification failed:", notificationError.message);
    }
    
    context.res = {
      status: 200,
      body: {
        success: true,
        message: "Review submitted for approval."
      }
    };

    return;
  }

  context.res = {
    status: 405,
    body: {
      error: "Method not allowed."
    }
  };
};
