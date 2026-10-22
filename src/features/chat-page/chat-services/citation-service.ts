import { sealNonSalesforceCitation, validNonSalesforceCitation, legacyOrigin } from "@/features/common/services/salesforce-history-access";
import { isPersonalSalesforceUser } from "@/features/common/services/salesforce-personal";
import { userHashedId } from "@/features/auth-page/helpers";
import { ServerActionResponse } from "@/features/common/server-action-response";
import { HistoryContainer } from "@/features/common/services/cosmos";
import { uniqueId } from "@/features/common/util";
import { SqlQuerySpec } from "@azure/cosmos";
import { DocumentSearchResponse } from "./azure-ai-search/azure-ai-search";
import { CHAT_CITATION_ATTRIBUTE, ChatCitationModel } from "./models";

export const CreateCitation = async (
  model: ChatCitationModel
): Promise<ServerActionResponse<ChatCitationModel>> => {
  try {
    const { resource } =
      await HistoryContainer().items.create<ChatCitationModel>(model);

    if (!resource) {
      return {
        status: "ERROR",
        errors: [{ message: "Citation not created" }],
      };
    }

    return {
      status: "OK",
      response: resource,
    };
  } catch (error) {
    return {
      status: "ERROR",
      errors: [{ message: `${error}` }],
    };
  }
};

// Create citations for the documents with a user as optional parameter
// when calling this method from the extension, you must provide the user as the REST API does not have access to the user
export const CreateCitations = async (
  models: DocumentSearchResponse[],
  userId?: string,
  origin: "sf" | "non_sf" = "sf"
): Promise<Array<ServerActionResponse<ChatCitationModel>>> => {
  const items: Array<Promise<ServerActionResponse<ChatCitationModel>>> = [];

  for (const model of models) {
    const item:ChatCitationModel = {
      content: model,
      id: uniqueId(),
      type: CHAT_CITATION_ATTRIBUTE,
      userId: userId || (await userHashedId()),
    };
    // These callers are server-side document searches, including Teams paths
    // without a Web session. Provenance does not grant cross-owner access.
    if (origin === "non_sf" && process.env.SF_PERSONAL_MODE === "true" && (process.env.SF_PERSONAL_SIGNING_KEY?.length??0)>=32) item.nonSalesforceSeal=sealNonSalesforceCitation(item);
    items.push(CreateCitation(item));
  }

  return await Promise.all(items);
};

export const FindCitationByID = async (
  id: string
): Promise<ServerActionResponse<ChatCitationModel>> => {
  try {
    const querySpec: SqlQuerySpec = {
      query:
        "SELECT * FROM root r WHERE r.type=@type AND r.id=@id AND r.userId=@userId",
      parameters: [
        { name: "@userId", value: await userHashedId() },
        {
          name: "@type",
          value: CHAT_CITATION_ATTRIBUTE,
        },
        {
          name: "@id",
          value: id,
        },
      ],
    };

    const { resources } = await HistoryContainer()
      .items.query<ChatCitationModel>(querySpec)
      .fetchAll();

    if (resources.length === 0) {
      return {
        status: "ERROR",
        errors: [{ message: "Citation not found" }],
      };
    }

    // Legacy citations have no trustworthy SF provenance; do not expose their bodies.
    if(await isPersonalSalesforceUser() && !validNonSalesforceCitation(resources[0]) && legacyOrigin({id,content:JSON.stringify(resources[0].content),threadId:""},await userHashedId())!=="non_sf")return {status:"ERROR",errors:[{message:"保存された出典の権限を再検証できません。再検索してください。"}]};

    return {
      status: "OK",
      response: resources[0],
    };
  } catch (error) {
    return {
      status: "ERROR",
      errors: [{ message: `${error}` }],
    };
  }
};

export const FormatCitations = (citation: DocumentSearchResponse[]) => {
  const withoutEmbedding: DocumentSearchResponse[] = [];

  citation.forEach((d) => {
    const fileUrl = d.document.fileUrl ?? "";
    const effectiveFileUrl = d.document.effectiveFileUrl ?? fileUrl;

    console.log(
      "[CITATION] stored effectiveFileUrl=",
      d.document.effectiveFileUrl,
      "fileUrl=",
      d.document.fileUrl
    );

    withoutEmbedding.push({
      score: d.score,
      document: {
        metadata: d.document.metadata,
        pageContent: d.document.pageContent,
        chatThreadId: d.document.chatThreadId,

        fileUrl,

        effectiveFileUrl: effectiveFileUrl || null,
        id: "",
        user: "",
        dept: d.document.dept ?? "",
        isSlDoc: d.document.isSlDoc ?? null,
        slScope: d.document.slScope ?? null,
        slOwner: d.document.slOwner ?? null,
        spItemId: d.document.spItemId ?? null,
      },
    });
  });

  return withoutEmbedding;
};
